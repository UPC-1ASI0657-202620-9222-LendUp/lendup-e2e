// Prueba de punta a punta a través del Gateway. La inyección de eventos se usa para probar transporte e idempotencia.
// Deja un reporte en reportes/e2e-ocho-microservicios.md. Uso: node scripts/e2e.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { revisar, revisarEjemplos } from './contratos.mjs';
import { ADMIN, BORROWER, HOUR, LENDER, OUTSIDER, SPY, call, check, compose, disableFirebaseAccount, emailOf, ensureUser, env, expect, firebaseAccount, historia, ids, lima, publish, publishEnvelope, rabbit, results, root, sleep, sql, token, until } from './lib.mjs';

const started = new Date(Date.now() - 2000);

// --- pasos reutilizables ------------------------------------------------------------------------------------------
async function publicar(garantia = 50) {
  const r = await call('POST', '/catalogo/publicaciones', LENDER, {
    detalles: { categoriaId: 'c0000000-0000-4000-8000-000000000002', titulo: 'Calculadora Casio', descripcion: 'Calculadora científica', condicionObjeto: 'Buen estado', universidad: 'UPC', campus: 'Monterrico', ubicacion: 'Pabellón A' },
    condiciones: { tarifaDiaria: 20, garantiaMonetaria: garantia, moneda: 'PEN', lugarIntercambio: 'Campus Monterrico', condicionesUso: 'Uso académico', condicionesEntrega: 'Entrega personal', condicionesDevolucion: 'Mismo estado', condicionesCancelacion: 'Antes de la entrega' }
  });
  if (r.status !== 201) throw new Error(`Catálogo no publicó: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  const d = await call('POST', `/catalogo/publicaciones/${r.body.id}/disponibilidades`, LENDER, { desde: lima(Date.now() - 30 * 24 * HOUR), hasta: lima(Date.now() + 120 * 24 * HOUR) });
  if (d.status !== 201) throw new Error(`Catálogo no guardó la disponibilidad: HTTP ${d.status} ${JSON.stringify(d.body)}`);
  return r.body.id;
}
async function solicitar(desdeMs, hastaMs, publicacion) {
  const desde = lima(desdeMs), hasta = lima(hastaMs);
  const snap = await call('GET', `/catalogo/publicaciones/${publicacion}/snapshot?desde=${desde}&hasta=${hasta}`, null);
  if (snap.status !== 200) throw new Error(`Catálogo no entregó el snapshot: HTTP ${snap.status} ${JSON.stringify(snap.body)}`);
  return call('POST', '/solicitudes', BORROWER, { publicacion_id: publicacion, desde, hasta, aceptacion_condiciones: { snapshot_id: snap.body.snapshot_id, snapshot_hash: snap.body.snapshot_hash, aceptada: true } });
}
async function reservar(desdeMs, hastaMs, publicacion) {
  publicacion ??= await publicar();
  const solicitud = await solicitar(desdeMs, hastaMs, publicacion);
  expect('Reservas: el prestatario solicita el objeto publicado en Catálogo', solicitud, 201);
  const reserva = await call('POST', `/solicitudes/${solicitud.body.id}/aceptacion`, LENDER);
  expect('Reservas: el prestamista acepta y se confirma la reserva', reserva, 201, (b) => b.estado === 'CONFIRMADA');
  const prestamo = await until('que Préstamos cree el préstamo', async () => (await call('GET', '/prestamos', BORROWER)).body.find?.((p) => p.reserva_id === reserva.body.id));
  check('Préstamos: creó el préstamo desde reservas.confirmada.v1', prestamo.estado === 'RESERVADO', prestamo.estado);
  return { reserva: reserva.body.id, prestamo: prestamo.id, publicacion };
}
const simulador = (url, resultado) => fetch(`${url}?resultado=${resultado}`, { method: 'POST', headers: { Accept: 'application/json' } }).then((x) => x.json());
async function cobrar(path, body, nombre) {
  const r = await until(`que Pagos conozca el préstamo (${nombre})`, async () => { const x = await call('POST', path, BORROWER, body); return [404, 409].includes(x.status) ? null : x; });
  expect(`Pagos: ${nombre} queda PENDIENTE con checkout_url`, r, 201, (b) => !!b.checkout_url);
  return r.body;
}
async function pagar(path, body, nombre) {
  const t = await cobrar(path, body, nombre);
  const ok = await simulador(t.checkout_url, 'aprobado');
  check(`Pagos: ${nombre} aprobado en el simulador de Mercado Pago`, ok.estado_transaccion === 'CONFIRMADA', ok.estado_transaccion);
}
const tarifaBody = (p, monto, clave = `tarifa-${p}`) => ({ prestamo_id: p, tipo: 'PAGO_TARIFA', monto, medio_pago_seleccionado: 'MERCADO_PAGO', clave_idempotencia: clave });
const garantiaBody = (p) => ({ prestamo_id: p, medio_pago_seleccionado: 'MERCADO_PAGO', clave_idempotencia: `garantia-${p}` });
const loan = async (id, uid = BORROWER) => (await call('GET', `/prestamos/${id}`, uid)).body;
const transacciones = async (id) => (await call('GET', `/prestamos/${id}/transacciones`, BORROWER)).body;
const transaccion = (id, tipo, estado = 'CONFIRMADA') => until(`${tipo} ${estado} en Pagos`, async () => (await transacciones(id)).find?.((t) => t.tipo === tipo && t.estado === estado));
async function pagarTodo(prestamo, tarifa) {
  await pagar('/pagos', tarifaBody(prestamo, tarifa), 'tarifa');
  await pagar('/garantias', garantiaBody(prestamo), 'garantía');
  await until('que Préstamos registre el pago y la garantía', async () => { const l = await loan(prestamo); return l.pago_tarifa_confirmado_en && l.garantia_constituida_en; });
  check('Préstamos: recibió pago-confirmado y garantia-constituida', true);
}
async function entregarYRecibir(prestamo) {
  expect('Préstamos: entrega registrada', await call('POST', `/prestamos/${prestamo}/entrega`, LENDER), 200, (b) => b.estado === 'ENTREGA_REGISTRADA');
  expect('Préstamos: recepción confirmada y préstamo activo', await call('POST', `/prestamos/${prestamo}/recepcion`, BORROWER), 200, (b) => b.estado === 'ACTIVO');
}
const activo = async (desdeMs, hastaMs, tarifa) => { const x = await reservar(desdeMs, hastaMs); await pagarTodo(x.prestamo, tarifa); await entregarYRecibir(x.prestamo); return x; };
const fecha = (n) => new Date(n.creada_en.endsWith('Z') ? n.creada_en : n.creada_en + 'Z');
const avisos = async (uid) => (await call('GET', '/notificaciones', uid)).body;
async function aviso(uid, titulo, quien, filtro = () => true) {
  const n = await until(`el aviso "${titulo}"`, async () => (await avisos(uid)).find?.((x) => x.titulo === titulo && fecha(x) >= started && filtro(x)));
  check(`Notificaciones: ${quien} recibe "${titulo}"`, true, n.mensaje);
  return n;
}
const masHoras = (local, h) => lima(new Date(local + '-05:00').getTime() + h * HOUR);

// --- historias ----------------------------------------------------------------------------------------------------
async function identidadYCatalogo() {
  historia('1. Identidad, Catálogo y seguridad de acceso');
  for (const uid of [LENDER, BORROWER, OUTSIDER]) {
    const { me, doc } = await ensureUser(uid);
    expect(`Identidad: ${uid} registrado y con correo verificado`, me, 200, (b) => b.usuario.estado_verificacion === 'VERIFICADO');
    if (uid === LENDER) expect('Identidad: entrega los términos vigentes', doc, 200, (b) => !!b.version_terminos);
  }
  const internal = 'http://localhost:8085/internal/v1/identidad';
  const uidRoute = `/firebase/${encodeURIComponent(BORROWER)}`;
  const serviceToken = env.IDENTITY_LOANS_SERVICE_TOKEN;
  if (!serviceToken || serviceToken.length < 32) throw new Error('Ejecuta node scripts/setup.mjs para configurar la credencial de Préstamos');
  const loansConfig = (name) => compose('exec', '-T', 'loans', 'printenv', name).trim();
  const usesServiceCredential =
    loansConfig('IDENTITY_SERVICE_BASE_URL') === 'http://identity:8081' &&
    loansConfig('IDENTITY_FIREBASE_USER_URI_TEMPLATE') === '/internal/v1/identidad/firebase/{uid}' &&
    loansConfig('IDENTITY_SERVICE_TOKEN') === serviceToken;
  check('Préstamos: el contenedor usa la ruta interna y su credencial exclusiva', usesServiceCredential);
  const loansCredential = 'raw:' + serviceToken;
  const resolved = await call('GET', uidRoute, loansCredential, undefined, internal);
  check('Identidad: credencial de Préstamos resuelve solo usuario_id', resolved.status === 200 &&
    resolved.body.usuario_id === ids[BORROWER] && Object.keys(resolved.body).length === 1, `HTTP ${resolved.status}`);
  expect('Identidad: credencial interna inválida devuelve 401', await call('GET', uidRoute, 'raw:' + randomUUID(), undefined, internal), 401);
  expect('Identidad: Firebase ID token en ruta interna devuelve 401', await call('GET', uidRoute, BORROWER, undefined, internal), 401);
  for (const route of ['correo', 'rol', 'elegibilidad', `contacto?reserva_id=${randomUUID()}`]) {
    const denied = await call('GET', `/usuarios/${ids[BORROWER]}/${route}`, loansCredential, undefined, internal);
    expect(`Identidad: Préstamos no tiene permiso para ${route.split('?')[0]}`, denied, 403);
  }
  expect('Catálogo: categorías públicas sin sesión', await call('GET', '/catalogo/categorias', null), 200, (b) => b.length >= 8);
  const publicacion = await publicar();
  expect('Catálogo: la publicación es visible', await call('GET', `/catalogo/publicaciones/${publicacion}`, null), 200, (b) => b.propietarioUsuarioId === ids[LENDER]);
  expect('Reservas: nadie puede solicitar su propio objeto', await (async () => {
    const desde = lima(Date.now() + 24 * HOUR), hasta = lima(Date.now() + 48 * HOUR);
    const s = (await call('GET', `/catalogo/publicaciones/${publicacion}/snapshot?desde=${desde}&hasta=${hasta}`, null)).body;
    return call('POST', '/solicitudes', LENDER, { publicacion_id: publicacion, desde, hasta, aceptacion_condiciones: { snapshot_id: s.snapshot_id, snapshot_hash: s.snapshot_hash, aceptada: true } });
  })(), 409);
  const protegidas = { Préstamos: '/prestamos', Pagos: '/medios-pago', Notificaciones: '/notificaciones', Evidencias: '/incidencias' };
  for (const [servicio, ruta] of Object.entries(protegidas)) {
    expect(`${servicio}: sin token responde 401`, await call('GET', ruta, null), 401);
    expect(`${servicio}: token inválido responde 401`, await call('GET', ruta, 'raw:no-es-un-token'), 401);
  }
  await firebaseAccount('e2e-sin-verificar', false);
  for (const [servicio, ruta] of Object.entries(protegidas)) expect(`${servicio}: correo sin verificar responde 403`, await call('GET', ruta, 'e2e-sin-verificar'), 403);
  await firebaseAccount('e2e-sin-registro');
  for (const servicio of ['Préstamos', 'Notificaciones', 'Evidencias']) {
    const r = await call('GET', protegidas[servicio], 'e2e-sin-registro');
    check(`${servicio}: cuenta de Firebase sin registro en LendUp no entra`, [401, 403, 404].includes(r.status), `HTTP ${r.status}`);
  }
  for (const ruta of [`/internal/v1/prestamos/reservas/${randomUUID()}/participantes/${randomUUID()}/contacto`, `/internal/v1/identidad/firebase/${BORROWER}`, `/internal/v1/catalogo/publicaciones/${publicacion}/snapshot`]) {
    const r = await call('GET', ruta, BORROWER, undefined, 'http://localhost:8090');
    check(`Gateway: no publica ${ruta.split('/').slice(0, 4).join('/')}`, r.status === 404, `HTTP ${r.status}`);
  }
  const propio = await call('GET', '/prestamos', LENDER);
  expect('Préstamos: resuelve al usuario por Identidad desde el Gateway', propio, 200, Array.isArray);
  check('Gateway: agrega X-Correlation-ID', (propio.headers.get('x-correlation-id') ?? '').length >= 8, propio.headers.get('x-correlation-id'));
}

async function solicitudes() {
  historia('2. Solicitudes rechazadas y canceladas (RF15)');
  const publicacion = await publicar();
  const rechazada = await solicitar(Date.now() + 24 * HOUR, Date.now() + 48 * HOUR, publicacion);
  expect('Reservas: solicitud creada', rechazada, 201);
  await aviso(LENDER, 'Nueva solicitud', 'el prestamista', (n) => n.origen_id === rechazada.body.id);
  await aviso(BORROWER, 'Solicitud enviada', 'el prestatario', (n) => n.origen_id === rechazada.body.id);
  expect('Reservas: el prestamista la rechaza', await call('POST', `/solicitudes/${rechazada.body.id}/rechazo`, LENDER, { motivo_rechazo: 'No estará disponible' }), 200);
  await aviso(BORROWER, 'Solicitud rechazada', 'el prestatario', (n) => n.origen_id === rechazada.body.id);
  const cancelada = await solicitar(Date.now() + 72 * HOUR, Date.now() + 96 * HOUR, publicacion);
  expect('Reservas: otra solicitud creada', cancelada, 201);
  await aviso(LENDER, 'Nueva solicitud', 'el prestamista', (n) => n.origen_id === cancelada.body.id);
  expect('Reservas: el prestatario la cancela', await call('POST', `/solicitudes/${cancelada.body.id}/cancelacion`, BORROWER, { motivo_cancelacion: 'Ya no lo necesito' }), 200);
  await aviso(LENDER, 'Solicitud cancelada', 'el prestamista', (n) => n.origen_id === cancelada.body.id);
}

async function cicloCompleto() {
  historia('3. Ciclo completo con extensión pagada y calificaciones');
  const { reserva, prestamo, publicacion } = await reservar(Date.now() - HOUR, Date.now() + 47 * HOUR);
  expect('Préstamos: sin pagar no se puede entregar', await call('POST', `/prestamos/${prestamo}/entrega`, LENDER), 409);
  expect('Reputación: no se califica un préstamo sin finalizar', await call('POST', `/prestamos/${prestamo}/calificaciones`, BORROWER, { puntaje: 5 }), 404);
  const desglose = await until('que Pagos conozca el préstamo', async () => { const r = await call('GET', `/prestamos/${prestamo}/desglose-pago`, BORROWER); return r.status === 200 && r; });
  expect('Pagos: desglosa tarifa, comisión de LendUp, garantía y total antes de pagar (RF37)', desglose, 200,
    (b) => b.tarifa === 40 && b.comision_lendup === 40 * Number(env.LENDUP_COMMISSION_PERCENT) / 100 && b.garantia === 50 && b.total_prestatario === 90);
  const rechazo = await cobrar('/pagos', tarifaBody(prestamo, 40, `rechazo-${prestamo}`), 'tarifa');
  check('Pagos: Mercado Pago rechaza el primer intento', (await simulador(rechazo.checkout_url, 'rechazado')).estado_transaccion === 'RECHAZADA');
  await aviso(BORROWER, 'Pago no confirmado', 'el prestatario');
  expect('Pagos: monto distinto al acordado responde 400', await call('POST', '/pagos', BORROWER, tarifaBody(prestamo, 1, `mal-${prestamo}`)), 400);
  expect('Pagos: solo el prestatario paga', await call('POST', '/pagos', LENDER, tarifaBody(prestamo, 40, `ajeno-${prestamo}`)), 403);
  await pagarTodo(prestamo, 40);
  await aviso(LENDER, 'Pago recibido', 'el prestamista');
  await aviso(LENDER, 'Garantía constituida', 'el prestamista');
  expect('Reservas + Préstamos + Identidad: contacto vigente de la contraparte', await call('GET', `/reservas/${reserva}/contacto`, BORROWER), 200, (b) => b.telefono === '999111222');
  expect('Préstamos: el prestatario no puede registrar la entrega', await call('POST', `/prestamos/${prestamo}/entrega`, BORROWER), 403);
  await entregarYRecibir(prestamo);
  await aviso(BORROWER, 'Objeto entregado', 'el prestatario', (n) => n.origen_id === prestamo);
  const liberacion = await transaccion(prestamo, 'LIBERACION_TARIFA');
  check('Pagos: liberó la tarifa descontando la comisión de LendUp', liberacion.comision_lendup === 40 * Number(env.LENDUP_COMMISSION_PERCENT) / 100, `comisión ${liberacion.comision_lendup}`);
  await aviso(LENDER, 'Préstamo activo', 'el prestamista', (n) => n.origen_id === prestamo);
  await aviso(LENDER, 'Tarifa liberada', 'el prestamista');
  const antes = await loan(prestamo), nueva = masHoras(antes.devolucion_vigente_en, 25);
  expect('Préstamos: cotiza 25 horas como 2 bloques', await call('POST', `/prestamos/${prestamo}/extensiones/cotizacion`, BORROWER, { fecha_propuesta_en: nueva }), 200, (b) => b.costo_adicional === 40);
  const ext = await call('POST', `/prestamos/${prestamo}/extensiones`, BORROWER, { fecha_propuesta_en: nueva, costo_adicional: 40, moneda: 'PEN' });
  expect('Préstamos: extensión solicitada', ext, 201, (b) => b.estado === 'PENDIENTE');
  await aviso(LENDER, 'Extensión solicitada', 'el prestamista', (n) => n.origen_id === ext.body.id);
  const cargoExtension = { prestamo_id: prestamo, cambio_fecha_prestamo_id: ext.body.id, tipo: 'PAGO_EXTENSION', monto: 40, medio_pago_seleccionado: 'MERCADO_PAGO', clave_idempotencia: `ext-${ext.body.id}` };
  expect('Pagos: no hay checkout antes de retener', await call('POST', '/pagos', BORROWER, cargoExtension), 409);
  expect('Préstamos: aceptación espera primero la retención', await call('POST', `/prestamos/${prestamo}/extensiones/${ext.body.id}/respuesta`, LENDER, { estado: 'ACEPTADA_PENDIENTE_PAGO' }), 200, (b) => b.estado === 'ACEPTADA_PENDIENTE_RETENCION');
  await aviso(BORROWER, 'Extensión aceptada', 'el prestatario', (n) => n.origen_id === ext.body.id);
  const finActual = new Date(antes.devolucion_vigente_en + '-05:00').getTime();
  const rival = await solicitar(finActual + HOUR, finActual + 2 * HOUR, publicacion);
  expect('Reservas: solicitud sobre una retención aún no es confirmación', rival, 201);
  expect('Reservas: una retención vigente impide aceptar una reserva superpuesta', await call('POST', `/solicitudes/${rival.body.id}/aceptacion`, LENDER), 409);
  check('Préstamos: la retención no altera la fecha vigente', (await loan(prestamo)).devolucion_vigente_en === antes.devolucion_vigente_en);
  await pagar('/pagos', cargoExtension, 'extensión');
  const extendido = await until('que Préstamos aplique la extensión', async () => { const l = await loan(prestamo); return l.devolucion_vigente_en === nueva && l; });
  check('Préstamos: nueva fecha vigente y conserva la original', extendido.devolucion_original_en === antes.devolucion_original_en && extendido.cambios_fecha[0].estado === 'APLICADA', extendido.devolucion_vigente_en);
  const reservaExtendida = await until(
  'que Reservas actualice la ocupacion por extension',
  async () => {
    const respuesta = await call('GET', '/reservas', BORROWER);

    return respuesta.body.find?.(
      (x) => x.id === reserva &&
             x.ocupacion_hasta === nueva
    );
  }
);

check(
  'Reservas: extension pagada actualiza ocupacion y conserva contrato',
  reservaExtendida.ocupacion_hasta === extendido.devolucion_vigente_en &&
  reservaExtendida.hasta === antes.devolucion_original_en,
  reservaExtendida.ocupacion_hasta
);
  await aviso(BORROWER, 'Nueva fecha de devolución', 'el prestatario', (n) => n.origen_id === ext.body.id);
  expect('Préstamos: devolución registrada', await call('POST', `/prestamos/${prestamo}/devolucion`, BORROWER), 200, (b) => b.estado === 'DEVOLUCION_REGISTRADA');
  await aviso(LENDER, 'Devolución registrada', 'el prestamista', (n) => n.origen_id === prestamo);
  expect('Préstamos: devolución confirmada y préstamo finalizado', await call('POST', `/prestamos/${prestamo}/confirmacion-devolucion`, LENDER), 200, (b) => b.estado === 'FINALIZADO');
  await transaccion(prestamo, 'DEVOLUCION_GARANTIA');
  check('Pagos: devolvió la garantía al recibir prestamos.finalizado.v1', true);
  await aviso(BORROWER, 'Préstamo finalizado', 'el prestatario', (n) => n.origen_id === prestamo);
  await aviso(BORROWER, 'Garantía devuelta', 'el prestatario');
  const r = await until('que Reservas acorte el periodo', async () => (await call('GET', '/reservas', BORROWER)).body.find?.((x) => x.id === reserva && x.periodo_liberado_desde));
  check('Reservas: liberó el periodo al recibir prestamos.periodo-liberado.v1', true, r.ocupacion_hasta);
  const contacto = await call('GET', `/reservas/${reserva}/contacto`, BORROWER);
  check('Reservas + Préstamos: al finalizar, el contacto deja de mostrarse', [403, 409].includes(contacto.status), `HTTP ${contacto.status}`);
  const calificar = async (uid, puntaje, comentario) => until('que Reputación conozca el préstamo finalizado', async () => { const x = await call('POST', `/prestamos/${prestamo}/calificaciones`, uid, { puntaje, comentario }); return x.status === 404 ? null : x; });
  expect('Reputación: el prestatario califica al prestamista', await calificar(BORROWER, 5, 'Todo bien'), 201, (b) => b.evaluado_usuario_id === ids[LENDER]);
  expect('Reputación: el prestamista califica al prestatario', await calificar(LENDER, 4), 201);
  expect('Reputación: no se califica dos veces', await call('POST', `/prestamos/${prestamo}/calificaciones`, BORROWER, { puntaje: 1 }), 409);
  expect('Reputación: un ajeno no califica', await call('POST', `/prestamos/${prestamo}/calificaciones`, OUTSIDER, { puntaje: 1 }), 403);
  expect('Reputación: muestra el promedio', await call('GET', `/estudiantes/${ids[LENDER]}/reputacion`, BORROWER), 200, (b) => b.cantidad >= 1 && b.promedio > 0);
  await aviso(LENDER, 'Nueva calificación', 'el prestamista', (n) => n.origen_id === prestamo);
  const n = await aviso(BORROWER, 'Nueva calificación', 'el prestatario', (x) => x.origen_id === prestamo);
  expect('Notificaciones: el estudiante la marca como leída', await call('PATCH', `/notificaciones/${n.id}`, BORROWER), 200, (b) => b.estado === 'LEIDA');
  expect('Notificaciones: nadie marca avisos ajenos', await call('PATCH', `/notificaciones/${n.id}`, OUTSIDER), 403);
  expect('Préstamos: historial de finalizados (US25)', await call('GET', '/prestamos?estado=FINALIZADO', BORROWER), 200, (b) => b.some((p) => p.id === prestamo));
  const correos = await until('que se envíen los correos', async () => { const c = sql('lendup_notificaciones', `select count(*) from lendup_notificaciones.notificaciones where estado_correo='ENVIADO' and origen_id='${prestamo}'`); return c.ok && Number(c.out) > 0 && c.out; });
  check('Notificaciones + Identidad: los correos salen (modo log) con la dirección de Identidad', true, `${correos} enviados`);
}

async function cancelacion() {
  historia('4. Saga de cancelación con reembolsos');
  const { reserva, prestamo, publicacion } = await reservar(Date.now() + 48 * HOUR, Date.now() + 96 * HOUR);
  await pagarTodo(prestamo, 40);
  expect('Reservas: cancelación solicitada', await call('POST', `/reservas/${reserva}/cancelacion`, BORROWER, { motivo_cancelacion: 'Ya no lo necesito' }), 200, (b) => b.estado === 'CANCELACION_PENDIENTE');
  await until('que Préstamos cancele', async () => (await loan(prestamo)).estado === 'CANCELADO');
  check('Préstamos: aceptó la cancelación (prestamos.cancelado.v1)', true);
  await until('que Reservas cancele', async () => (await call('GET', '/reservas', BORROWER)).body.find?.((x) => x.id === reserva && x.estado === 'CANCELADA'));
  check('Reservas: quedó CANCELADA y liberó el periodo', true);
  await transaccion(prestamo, 'REEMBOLSO_TARIFA'); await transaccion(prestamo, 'DEVOLUCION_GARANTIA');
  check('Pagos: reembolsó la tarifa y devolvió la garantía', true);
  await aviso(BORROWER, 'Reembolso procesado', 'el prestatario');
  await aviso(LENDER, 'Reserva cancelada', 'el prestamista', (n) => n.origen_id === reserva);
  const pendientes = sql('lendup_notificaciones', `select count(*) from lendup_notificaciones.notificaciones where origen_id='${reserva}' and estado='PROGRAMADA'`);
  check('Notificaciones: anuló los recordatorios de la reserva', pendientes.out === '0', `${pendientes.out} programados`);
  await reservar(Date.now() + 48 * HOUR, Date.now() + 96 * HOUR, publicacion);
  check('Reservas: el periodo liberado se puede volver a reservar', true);
}

async function cancelacionRechazada() {
  historia('5. Cancelación según la recepción');
  const recuperacion = await reservar(Date.now() - HOUR, Date.now() + 23 * HOUR);
  await pagarTodo(recuperacion.prestamo, 20);
  expect('Préstamos: entrega registrada sin recepción', await call('POST', `/prestamos/${recuperacion.prestamo}/entrega`, LENDER), 200);
  expect('Reservas: admite solicitud con entrega registrada', await call('POST', `/reservas/${recuperacion.reserva}/cancelacion`, BORROWER, { motivo_cancelacion: 'Recuperar el objeto' }), 200);
  await until('que se espere recuperación', async () => (await loan(recuperacion.prestamo)).estado_detalle === 'RECUPERACION_PENDIENTE');
  await aviso(LENDER, 'Recuperación pendiente', 'el prestamista', (n) => n.origen_id === recuperacion.prestamo);
  check('Reservas: no libera ocupación mientras falta recuperación', (await call('GET', '/reservas', BORROWER)).body.some((r) => r.id === recuperacion.reserva && r.estado === 'CANCELACION_PENDIENTE'));
  const tramoEnCustodia = [Date.now() + 2 * HOUR, Date.now() + 5 * HOUR, recuperacion.publicacion];
  expect('Reservas: la custodia pendiente impide solicitar el tramo ocupado', await solicitar(...tramoEnCustodia), 409);
  const tramoPosterior = [Date.now() + 25 * HOUR, Date.now() + 30 * HOUR, recuperacion.publicacion];
  expect('Reservas: la custodia supera el fin contractual si falta recuperación', await solicitar(...tramoPosterior), 409);
  check('Pagos: antes de recuperar no hay reembolsos', !(await transacciones(recuperacion.prestamo)).some((t) => ['REEMBOLSO_TARIFA', 'DEVOLUCION_GARANTIA'].includes(t.tipo)));
  expect('Préstamos: prestatario no confirma recuperación', await call('POST', `/prestamos/${recuperacion.prestamo}/confirmacion-recuperacion`, BORROWER), 403);
  expect('Préstamos: no admite recepción mientras recupera', await call('POST', `/prestamos/${recuperacion.prestamo}/recepcion`, BORROWER), 409);
  expect('Préstamos: el prestamista confirma recuperación', await call('POST', `/prestamos/${recuperacion.prestamo}/confirmacion-recuperacion`, LENDER), 200, (b) => b.estado === 'CANCELADO');
  expect('Préstamos: confirmación de recuperación repetida es idempotente', await call('POST', `/prestamos/${recuperacion.prestamo}/confirmacion-recuperacion`, LENDER), 200, (b) => b.estado === 'CANCELADO');
  await until('que Reservas confirme cancelación por recuperación', async () => (await call('GET', '/reservas', BORROWER)).body.some((r) => r.id === recuperacion.reserva && r.estado === 'CANCELADA'));
  await reservar(...tramoEnCustodia);
  check('Reservas: puede volver a ocupar el tramo tras confirmar recuperación', true);
  await transaccion(recuperacion.prestamo, 'REEMBOLSO_TARIFA');
  await transaccion(recuperacion.prestamo, 'DEVOLUCION_GARANTIA');
  check('Pagos: reembolsa tarifa y garantía una vez después de recuperar', (await transacciones(recuperacion.prestamo)).filter((t) => ['REEMBOLSO_TARIFA', 'DEVOLUCION_GARANTIA'].includes(t.tipo)).length === 2);
  const { reserva, prestamo } = await reservar(Date.now() - HOUR, Date.now() + 23 * HOUR);
  await pagarTodo(prestamo, 20);
  await entregarYRecibir(prestamo);
  expect('Reservas: cancelación solicitada', await call('POST', `/reservas/${reserva}/cancelacion`, BORROWER, { motivo_cancelacion: 'Cambio de planes' }), 200);
  await until('que Reservas vuelva a CONFIRMADA', async () => (await call('GET', '/reservas', BORROWER)).body.find?.((x) => x.id === reserva && x.estado === 'CONFIRMADA'));
  check('Reservas: volvió a CONFIRMADA (prestamos.cancelacion-rechazada.v1)', true);
  check('Préstamos: la recepción confirmada impide cancelar', (await loan(prestamo)).estado === 'ACTIVO', 'ACTIVO');
  await aviso(BORROWER, 'Cancelación no aceptada', 'el prestatario', (n) => n.origen_id === prestamo);
}

async function cambiosDeFecha() {
  historia('6. Extensión rechazada y reprogramaciones');
  const { reserva, prestamo } = await activo(Date.now() - HOUR, Date.now() + 71 * HOUR, 60);
  const base = (await loan(prestamo)).devolucion_vigente_en;
  const ext = await call('POST', `/prestamos/${prestamo}/extensiones`, BORROWER, { fecha_propuesta_en: masHoras(base, 24) });
  expect('Préstamos: extensión solicitada', ext, 201);
  expect('Préstamos: el prestamista la rechaza', await call('POST', `/prestamos/${prestamo}/extensiones/${ext.body.id}/respuesta`, LENDER, { estado: 'RECHAZADA', motivo_rechazo: 'Lo necesito' }), 200);
  await aviso(BORROWER, 'Extensión rechazada', 'el prestatario', (n) => n.origen_id === ext.body.id);
  const rep = await call('POST', `/prestamos/${prestamo}/reprogramaciones`, LENDER, { fecha_propuesta_en: masHoras(base, 12) });
  expect('Préstamos: el prestamista propone reprogramar', rep, 201);
  await aviso(BORROWER, 'Reprogramación propuesta', 'el prestatario', (n) => n.origen_id === rep.body.id);
  expect('Préstamos: el prestatario la rechaza', await call('POST', `/prestamos/${prestamo}/reprogramaciones/${rep.body.id}/respuesta`, BORROWER, { estado: 'RECHAZADA', motivo_rechazo: 'Viajo ese día' }), 200);
  await aviso(LENDER, 'Reprogramación rechazada', 'el prestamista', (n) => n.origen_id === rep.body.id);
  const rep2 = await call('POST', `/prestamos/${prestamo}/reprogramaciones`, LENDER, { fecha_propuesta_en: masHoras(base, 30) });
  expect('Préstamos: nueva propuesta aceptada sin costo', await call('POST', `/prestamos/${prestamo}/reprogramaciones/${rep2.body.id}/respuesta`, BORROWER, { estado: 'APLICADA' }), 200, (b) => b.estado === 'APLICADA');
  const prestamoReprogramado = await until(
  'que Prestamos aplique la reprogramacion',
  async () => {
    const p = await loan(prestamo);

    return p.devolucion_vigente_en === masHoras(base, 30) && p;
  }
);

const reservaReprogramada = await until(
  'que Reservas actualice la ocupacion por reprogramacion',
  async () => {
    const respuesta = await call('GET', '/reservas', BORROWER);

    return respuesta.body.find?.(
      (x) => x.id === reserva &&
             x.ocupacion_hasta === prestamoReprogramado.devolucion_vigente_en
    );
  }
);

check(
  'Reservas: reprogramacion actualiza ocupacion y conserva contrato',
  reservaReprogramada.ocupacion_hasta === prestamoReprogramado.devolucion_vigente_en &&
  reservaReprogramada.hasta === prestamoReprogramado.devolucion_original_en,
  reservaReprogramada.ocupacion_hasta
);

  await aviso(LENDER, 'Nueva fecha de devolución', 'el prestamista', (n) => n.origen_id === rep2.body.id);
  const esperado = new Date(masHoras(base, 30) + '-05:00').getTime() - 24 * HOUR;
  const filas = sql('lendup_notificaciones', `select date_format(programada_para,'%Y-%m-%dT%H:%i:%sZ') from lendup_notificaciones.notificaciones where origen_id='${reserva}' and clave_notificacion like 'RecordatorioDevolucion:%' and estado='PROGRAMADA'`).out.split('\n');
  check('Notificaciones: movió el recordatorio de ambos a 24 h antes de la nueva fecha (RF22)', filas.length === 2 && filas.every((x) => Math.abs(new Date(x).getTime() - esperado) < 2000), filas[0]);
  expect('Préstamos: historial de cambios de fecha (US42)', await call('GET', `/prestamos/${prestamo}/cambios-fecha`, LENDER), 200, (b) => b.length === 3);
  expect('Préstamos: aparece en el calendario (US44)', await call('GET', '/calendario', LENDER), 200, (b) => JSON.stringify(b).includes(prestamo));
}

async function vencimiento() {
  historia('7. Vencimiento (RF53) y extensión que ya no corresponde');
  const { prestamo } = await activo(Date.now() - 24 * HOUR, Date.now() + 25_000, 40);
  const ext = await call('POST', `/prestamos/${prestamo}/extensiones`, BORROWER, { fecha_propuesta_en: masHoras((await loan(prestamo)).devolucion_vigente_en, 24) });
  expect('Préstamos: extensión solicitada antes de vencer', ext, 201);
  expect('Préstamos: aceptada, pero el prestatario no la paga', await call('POST', `/prestamos/${prestamo}/extensiones/${ext.body.id}/respuesta`, LENDER, { estado: 'ACEPTADA_PENDIENTE_PAGO' }), 200);
  const cobro = await cobrar('/pagos', { prestamo_id: prestamo, cambio_fecha_prestamo_id: ext.body.id, tipo: 'PAGO_EXTENSION', monto: 20, medio_pago_seleccionado: 'MERCADO_PAGO', clave_idempotencia: `ext-${ext.body.id}` }, 'extensión');
  await until('que el scheduler marque VENCIDO', async () => (await loan(prestamo)).estado === 'VENCIDO', 60);
  check('Préstamos: pasó a VENCIDO al llegar la fecha', true);
  await aviso(LENDER, 'Préstamo vencido', 'el prestamista', (n) => n.origen_id === prestamo);
  await aviso(BORROWER, 'Préstamo vencido', 'el prestatario', (n) => n.origen_id === prestamo);
  expect('Seguridad: un estudiante ajeno no ve el préstamo', await call('GET', `/prestamos/${prestamo}`, OUTSIDER), 403);
  expect('Seguridad: ni sus transacciones', await call('GET', `/prestamos/${prestamo}/transacciones`, OUTSIDER), 403);
  expect('Préstamos: se puede devolver aunque esté vencido', await call('POST', `/prestamos/${prestamo}/devolucion`, BORROWER), 200);
  await transaccion(prestamo, 'PAGO_EXTENSION', 'CANCELADA');
  check('Pagos: canceló el cobro de la extensión al registrarse la devolución', true);
  await simulador(cobro.checkout_url, 'aprobado');
  await transaccion(prestamo, 'REEMBOLSO_TARIFA');
  check('Pagos: si igual se paga, lo reembolsa y la fecha no cambia', (await loan(prestamo)).devolucion_vigente_en === (await loan(prestamo)).devolucion_original_en);
  expect('Préstamos: y finalizar', await call('POST', `/prestamos/${prestamo}/confirmacion-devolucion`, LENDER), 200, (b) => b.estado === 'FINALIZADO');
  await transaccion(prestamo, 'DEVOLUCION_GARANTIA');
  check('Pagos: devolvió la garantía', true);
}

async function retencionExpirada() {
  historia('Extensión: expiración y compensación de pago tardío');
  const { reserva, prestamo, publicacion } = await activo(Date.now() - HOUR, Date.now() + 23 * HOUR, 20);
  const original = (await loan(prestamo)).devolucion_vigente_en;
  const ext = await call('POST', `/prestamos/${prestamo}/extensiones`, BORROWER, { fecha_propuesta_en: masHoras(original, 24) });
  expect('Extensión tardía: se propone el cambio', ext, 201);
  expect('Extensión tardía: se solicita retención',
    await call('POST', `/prestamos/${prestamo}/extensiones/${ext.body.id}/respuesta`, LENDER, { estado: 'ACEPTADA_PENDIENTE_PAGO' }), 200);
  const cargo = { ...tarifaBody(prestamo, 20, `ext-${ext.body.id}`), tipo: 'PAGO_EXTENSION', cambio_fecha_prestamo_id: ext.body.id };
  const cobro = await cobrar('/pagos', cargo, 'extensión que expira');
  await until('que expire la retención', async () => (await loan(prestamo)).cambios_fecha.some((c) => c.id === ext.body.id && c.estado === 'RECHAZADA'), 65);
  expect('Pagos: no vuelve a entregar un checkout expirado', await call('POST', '/pagos', BORROWER, cargo), 409);
  const fin = new Date(original + '-05:00').getTime();
  const rival = await solicitar(fin + HOUR, fin + 2 * HOUR, publicacion);
  expect('Reservas: el tramo expirado es elegible para nueva solicitud', rival, 201);
  expect('Reservas: otro préstamo ocupa el tramo al vencer la retención', await call('POST', `/solicitudes/${rival.body.id}/aceptacion`, LENDER), 201);
  await simulador(cobro.checkout_url, 'aprobado');
  await simulador(cobro.checkout_url, 'aprobado');
  const refunds = await until('compensación de los dos cargos de prueba distintos', async () => {
    const rows = (await transacciones(prestamo)).filter((t) => t.tipo === 'REEMBOLSO_TARIFA' && t.estado === 'CONFIRMADA');
    return rows.length === 2 && rows;
  });
  check('Pagos: compensa una vez cada cargo tardío distinto', refunds.every((t) => t.monto === 20));
  const ocupacion = (await call('GET', '/reservas', BORROWER)).body.find((r) => r.id === reserva);
  check('Préstamos y Reservas: el pago tardío no aplica la nueva fecha',
    ocupacion.ocupacion_hasta === original && (await loan(prestamo)).devolucion_vigente_en === original);
}

const incidentBody = (prestamo, id = randomUUID()) => ({
  prestamo_id: prestamo, tipo: 'DANIO', descripcion: 'Se documentó una diferencia en el estado del objeto.',
  observaciones: ['Comparar las fotografías.'], clave_idempotencia: id
});
const reportar = (body, uid = LENDER) => call('POST', '/incidencias', uid, body);
const administrar = (id, operacion, uid = ADMIN, body) => call('POST', `/admin/incidencias/${id}/${operacion}`, uid, body);
const resolver = (id, decision, monto, motivo = 'La administración revisó las pruebas aportadas.') =>
  administrar(id, 'resolucion', ADMIN, { decision_garantia: decision, monto_garantia_afectado: monto, justificacion_resolucion: motivo });
const evidenceSql = (query) => sql('lendup_evidencias', query);
const outboxIncidente = (id, tipo) => evidenceSql(
  `select envelope from lendup_evidencias.outbox_events where aggregate_id='${id}' and routing_key='evidencias.incidencia-${tipo}.v1' and published_at is not null`);

async function prepararAdministrador() {
  await ensureUser(ADMIN);
  const promote = sql('lendup_identidad', `update lendup_identidad.usuarios set rol_id=(select id from lendup_identidad.roles where codigo='ADMINISTRADOR') where id='${ids[ADMIN]}'`);
  check('Identidad: se preparó un administrador persistido para E2E', promote.ok);
  const internal = 'http://localhost:8085/internal/v1/identidad';
  const credential = 'raw:' + env.IDENTITY_EVIDENCE_SERVICE_TOKEN;
  expect('Identidad: Evidencias obtiene el UUID vinculado a Firebase', await call('GET', `/firebase/${ADMIN}`, credential, undefined, internal), 200,
    (b) => b.usuario_id === ids[ADMIN] && Object.keys(b).length === 1);
  for (const [uid, rol] of [[ADMIN, 'ADMINISTRADOR'], [LENDER, 'ESTUDIANTE']]) {
    expect(`Identidad: Evidencias consulta el rol persistido ${rol}`, await call('GET', `/usuarios/${ids[uid]}/rol`, credential, undefined, internal), 200,
      (b) => b.rol === rol && Object.keys(b).length === 1);
  }
  expect('Identidad: Evidencias no puede consultar correo', await call('GET', `/usuarios/${ids[LENDER]}/correo`, credential, undefined, internal), 403);
  const firebaseToken = 'raw:' + await token(ADMIN);
  await disableFirebaseAccount(ADMIN, true);
  try {
    expect('Evidencias: un administrador Firebase deshabilitado no accede con su token anterior',
      await call('GET', '/admin/incidencias', firebaseToken), 401);
  } finally {
    await disableFirebaseAccount(ADMIN, false);
  }
}

async function contratoPrivado(prestamo, reserva) {
  const base = 'http://localhost:8087/internal/v1/prestamos';
  const incident = `/${prestamo}/incidencias`;
  const contact = `/reservas/${reserva}/participantes/${ids[LENDER]}/contacto`;
  const evidence = 'raw:' + env.LOANS_EVIDENCE_SERVICE_TOKEN;
  const reservations = 'raw:' + env.LOANS_RESERVATIONS_SERVICE_TOKEN;
  expect('Préstamos: contrato privado devuelve exclusivamente las condiciones pactadas y los participantes',
    await call('GET', incident, evidence, undefined, base), 200,
    (b) => Object.keys(b).length === 5 && b.id === prestamo && b.garantia_monetaria_acordada === 50 && b.moneda === 'PEN' &&
      b.prestamista_usuario_id === ids[LENDER] && b.prestatario_usuario_id === ids[BORROWER]);
  expect('Préstamos: contrato privado devuelve 404 para un identificador inexistente',
    await call('GET', `/${randomUUID()}/incidencias`, evidence, undefined, base), 404);
  expect('Préstamos: Reservas conserva permiso para contactos', await call('GET', contact, reservations, undefined, base), 200);
  expect('Préstamos: Reservas no puede consultar incidencias', await call('GET', incident, reservations, undefined, base), 403);
  expect('Préstamos: Evidencias no puede consultar contactos', await call('GET', contact, evidence, undefined, base), 403);
  for (const [nombre, credencial] of [['ausente', null], ['corta', 'raw:corta'], ['incorrecta', 'raw:' + randomUUID()], ['Firebase', LENDER]]) {
    expect(`Préstamos: rechaza credencial interna ${nombre}`, await call('GET', incident, credencial, undefined, base), 401);
  }
  expect('Gateway: no publica los datos administrativos de Préstamos',
    await call('GET', '/internal/v1/prestamos' + incident, evidence, undefined, 'http://localhost:8090'), 404);
  const seal = `/internal/v1/prestamos/${prestamo}/cierre-incidencias`;
  expect('Gateway: no publica el sellado de Evidencias', await call('POST', seal, LENDER, undefined, 'http://localhost:8090'), 404);
  expect('Evidencias: el sellado rechaza credenciales Firebase', await call('POST', seal, LENDER, undefined, 'http://localhost:8088'), 401);
}

async function acuerdoDespuesDeEditar(reserva, publicacion) {
  const route = `/internal/v1/reservas/${reserva}/acuerdo`;
  const base = 'http://localhost:8081';
  const credential = 'raw:' + env.RESERVATIONS_EVIDENCE_SERVICE_TOKEN;
  const read = (uid) => call('GET', route, uid, undefined, base);
  const original = await read(credential);
  expect('Reservas: Evidencias recibe solo el acuerdo original', original, 200, (b) =>
    b.id === reserva && b.condiciones_uso_acordadas === 'Uso académico' &&
    b.condiciones_entrega_acordadas === 'Entrega personal' && b.condiciones_devolucion_acordadas === 'Mismo estado' &&
    b.condiciones_cancelacion_acordadas === 'Antes de la entrega' && b.lugar_intercambio_acordado === 'Campus Monterrico' &&
    !!b.condiciones_aceptadas_en && !!b.condiciones_snapshot_hash &&
    Object.keys(b).length === 14);
  expect('Reservas: un usuario Firebase no obtiene el snapshot privado', await read(LENDER), 401,
    (b) => b.error === 'CREDENCIAL_DE_SERVICIO_INVALIDA' && b.message === 'Credencial de servicio inválida');
  expect('Reservas: la credencial de Préstamos no obtiene el snapshot privado', await read('raw:' + env.LOANS_RESERVATIONS_SERVICE_TOKEN), 401);
  expect('Reservas: la credencial de Evidencias solo tiene acceso de lectura al acuerdo',
    await call('POST', route, credential, undefined, base), 403);
  expect('Reservas: credencial de Evidencias no obtiene contactos por la ruta pública',
    await call('GET', `/api/v1/reservas/${reserva}/contacto`, credential, undefined, base), 401);
  expect('Gateway: mantiene privado el acuerdo de Reservas',
    await call('GET', route, credential, undefined, 'http://localhost:8090'), 404);
  const edit = await call('PATCH', `/catalogo/publicaciones/${publicacion}`, LENDER, {
    condiciones: { condicionesUso: 'Uso actualizado después de reservar', condicionesEntrega: 'Entrega posterior',
      condicionesDevolucion: 'Devolución posterior', condicionesCancelacion: 'Cancelación posterior',
      lugarIntercambio: 'Lugar posterior', garantiaMonetaria: 75 },
  });
  expect('Catálogo: acepta editar la publicación después de la reserva', edit, 200,
    (b) => b.condiciones.condicionesUso === 'Uso actualizado después de reservar' && b.condiciones.garantiaMonetaria === 75);
  const unchanged = (b) => Object.keys(original.body).every((key) => b?.[key] === original.body[key]);
  expect('Reservas: conserva importes, condiciones, periodo y prueba de aceptación tras editar Catálogo',
    await read(credential), 200, unchanged);
  return unchanged;
}

function foto(form, campo) {
  // JPEG de 1 píxel usado por los proveedores locales.
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8Af//Z', 'base64');
  form.append(campo, new Blob([jpeg], { type: 'image/jpeg' }), 'evidencia.jpg');
}

async function subirFoto(prestamo, etapa, actor) {
  const form = new FormData();
  form.set('etapa', etapa);
  form.set('uploadId', randomUUID());
  foto(form, 'file');
  const ruta = `/prestamos/${prestamo}/evidencias`;
  const subida = await call('POST', ruta, actor, form);
  expect(`Evidencias: registra foto multipart de ${etapa}`, subida, 201,
    (b) => b.etapa === etapa && b.tipo === 'FOTO' && b.estado_integracion === 'COMPLETADA' && !!b.cloudinary_public_id);
  expect(`Evidencias: reintenta la foto de ${etapa} sin duplicarla`, await call('POST', ruta, actor, form), 201, (b) => b.id === subida.body.id);
  return subida.body.id;
}

async function incidencias() {
  historia('8. Evidencias reales, revisión e incidencia con afectación parcial');
  await prepararAdministrador();
  const { prestamo, reserva, publicacion } = await reservar(Date.now() - HOUR, Date.now() + 23 * HOUR);
  await contratoPrivado(prestamo, reserva);
  const acuerdoOriginal = await acuerdoDespuesDeEditar(reserva, publicacion);
  await pagarTodo(prestamo, 20);
  const evidencePath = `/prestamos/${prestamo}/evidencias`;
  expect('Evidencias: registra observación de entrega por JSON', await call('POST', evidencePath, LENDER,
    { etapa: 'ENTREGA', tipo: 'OBSERVACION', observacion: 'Objeto inspeccionado antes de entregar.' }), 201);
  const initial = await subirFoto(prestamo, 'ENTREGA', LENDER);
  await entregarYRecibir(prestamo);
  const final = await subirFoto(prestamo, 'DEVOLUCION', BORROWER);
  expect('Evidencias: el participante puede consultar registros reales', await call('GET', evidencePath, BORROWER), 200,
    (b) => b.some((e) => e.id === initial) && b.some((e) => e.id === final));
  expect('Evidencias: un usuario ajeno no puede consultar registros', await call('GET', evidencePath, OUTSIDER), 403);
  check('Préstamos: el detalle contiene las evidencias de MySQL', (await loan(prestamo)).evidencias.some((e) => e.id === final));
  const analysisPath = `/prestamos/${prestamo}/analisis-evidencias`;
  const analysis = await call('POST', analysisPath, BORROWER, { evidencia_inicial_id: initial, evidencia_final_id: final });
  expect('Evidencias: acepta las fotografías verificadas para analizar', analysis, 201, (b) => b.estado === 'PENDIENTE');
  const analysisDone = await until('que termine el análisis', async () => {
    const r = await call('GET', `${analysisPath}/${analysis.body.id}`, LENDER);
    return r.body.estado === 'COMPLETADO' && r;
  });
  expect('Gateway: permite consultar el análisis y requiere revisión humana', analysisDone, 200,
    (b) => b.resultado_detalle.requiere_revision_humana === true && b.resultado_detalle.comparabilidad === 'MEDIA');
  expect('Préstamos: devolución registrada', await call('POST', `/prestamos/${prestamo}/devolucion`, BORROWER), 200);
  const body = incidentBody(prestamo);
  const incidencia = body.clave_idempotencia;
  expect('Evidencias: el usuario ajeno no puede reportar', await reportar(body, OUTSIDER), 403);
  const report = new FormData();
  report.set('reporte', new Blob([JSON.stringify(body)], { type: 'application/json' }));
  foto(report, 'fotos');
  expect('Evidencias: registra incidencia multipart con foto y observación', await call('POST', '/incidencias', LENDER, report), 201,
    (b) => b.id === incidencia && b.estado === 'PENDIENTE' && b.evidencias.length === 2);
  expect('Evidencias: reintentar el reporte conserva la misma incidencia', await reportar(body), 201,
    (b) => b.id === incidencia && b.evidencias.length === 2);
  expect('Evidencias: detecta reutilización de clave con contenido diferente',
    await reportar({ ...body, descripcion: 'Esta descripción es distinta de la original.' }), 409);
  expect('Evidencias: el participante puede consultar su incidencia', await call('GET', `/incidencias/${incidencia}`, BORROWER), 200,
    (b) => b.id === incidencia && b.prestamo.id === prestamo && b.garantia_monetaria_acordada === 50);
  expect('Evidencias: el usuario ajeno no consulta la incidencia', await call('GET', `/incidencias/${incidencia}`, OUTSIDER), 403);
  expect('Evidencias: el administrador puede consultar el detalle y sus pruebas',
    await call('GET', `/incidencias/${incidencia}`, ADMIN), 200,
    (b) => b.prestamo.id === prestamo && b.prestamo.garantia_monetaria_acordada === 50 && b.evidencias.length === 2);
  expect('Evidencias: el detalle administrativo presenta el acuerdo aceptado antes del cambio de Catálogo',
    await call('GET', `/incidencias/${incidencia}`, ADMIN), 200, (b) => acuerdoOriginal(b.reserva));
  expect('Evidencias: el listado del participante incluye la incidencia', await call('GET', '/incidencias', BORROWER), 200,
    (b) => b.some((i) => i.id === incidencia));
  expect('Evidencias: un estudiante no inicia revisión administrativa', await administrar(incidencia, 'revision', LENDER), 403);
  expect('Evidencias: un estudiante no lista la bandeja administrativa', await call('GET', '/admin/incidencias', BORROWER), 403);
  expect('Evidencias: el administrador lista las incidencias pendientes', await call('GET', '/admin/incidencias?estado=PENDIENTE&tipo=DANIO', ADMIN), 200,
    (b) => b.some((i) => i.id === incidencia && i.garantia_monetaria_acordada === 50 && i.prestamo.id === prestamo));
  expect('Evidencias: la bandeja administrativa conserva el acuerdo original',
    await call('GET', '/admin/incidencias?estado=PENDIENTE&tipo=DANIO', ADMIN), 200,
    (b) => b.some((i) => i.id === incidencia && acuerdoOriginal(i.reserva)));
  expect('Evidencias: el administrador inicia la revisión', await administrar(incidencia, 'revision'), 200, (b) => b.estado === 'EN_REVISION');
  expect('Evidencias: el administrador agrega una observación', await administrar(incidencia, 'observaciones', ADMIN,
    { contenido: 'Se compararán las fotos originales.' }), 200, (b) => b.observaciones.length === 1);
  const statement = { contenido: 'La contraparte presentó su descargo con contexto suficiente.' };
  expect('Evidencias: solo la contraparte presenta descargo', await call('POST', `/incidencias/${incidencia}/descargo`, LENDER, statement), 403);
  expect('Evidencias: guarda el descargo de la contraparte', await call('POST', `/incidencias/${incidencia}/descargo`, BORROWER, statement), 200,
    (b) => b.descargo === statement.contenido);
  expect('Evidencias: rechaza el descargo repetido', await call('POST', `/incidencias/${incidencia}/descargo`, BORROWER, statement), 409);
  const published = await until('publicación del reporte real', () => outboxIncidente(incidencia, 'reportada').out);
  check('Broker: evidencias.incidencia-reportada.v1 tiene suscriptores', JSON.parse(published).payload.incidencia_id === incidencia);
  await until('que Préstamos registre la incidencia', async () => (await loan(prestamo)).estado_detalle === 'PENDIENTE_INCIDENCIA');
  check('Préstamos: queda PENDIENTE_INCIDENCIA', true);
  expect('Préstamos: no se puede cerrar con una incidencia pendiente', await call('POST', `/prestamos/${prestamo}/confirmacion-devolucion`, LENDER), 409);
  await until('que Pagos retenga la garantía', async () => sql('lendup_pagos', `select estado from lendup_pagos.garantias where prestamo_id=uuid_to_bin('${prestamo}')`).out === 'RETENIDA_POR_INCIDENCIA');
  check('Pagos: la garantía queda RETENIDA_POR_INCIDENCIA (RF41)', true);
  await aviso(BORROWER, 'Incidencia reportada', 'el prestatario', (n) => n.origen_id === incidencia);
  const adelantada = randomUUID();
  const real = JSON.parse(published);
  const otra = { ...real.payload, incidencia_id: adelantada };
  check('Inyección controlada: resolución sin afectación llega antes de su reporte', await publish(
    'evidencias.incidencia-resuelta.v1', 'IncidenciaResuelta', adelantada,
    { ...otra, decision_garantia: 'SIN_AFECTACION', monto_garantia_afectado: 0, moneda: 'PEN',
      justificacion_resolucion: 'Caso controlado de evento fuera de orden.' }));
  await publish('evidencias.incidencia-reportada.v1', 'IncidenciaReportada', adelantada, otra);
  await publishEnvelope('evidencias.incidencia-reportada.v1', real);
  await until('que Pagos proyecte la resolución adelantada', async () => sql('lendup_pagos',
    `select decision from lendup_pagos.guarantee_incident_projection where incident_id='${adelantada}'`).out === 'SIN_AFECTACION');
  await until('que Préstamos proyecte la resolución adelantada', async () => sql('lendup_prestamos',
    `select resolved from lendup_prestamos.loan_incident_projection where incident_id='${adelantada}'`).out === '1');
  expect('Préstamos: una resolución adelantada no cierra otra incidencia', await call('POST', `/prestamos/${prestamo}/confirmacion-devolucion`, LENDER), 409);
  const reason = 'Daño leve comprobado en ambas fotografías.';
  expect('Evidencias: registra la resolución parcial y calcula saldo y moneda con datos pactados',
    await administrar(incidencia, 'resolucion', ADMIN, { decision_garantia: 'AFECTACION_PARCIAL', monto_garantia_afectado: 20,
      justificacion_resolucion: reason, saldo_garantia_previsto: 999, moneda: 'USD' }), 200,
    (b) => b.estado === 'RESUELTA' && Number(b.monto_garantia_afectado) === 20 && Number(b.saldo_garantia_previsto) === 30 && b.moneda === 'PEN');
  expect('Evidencias: rechaza una segunda resolución', await resolver(incidencia, 'AFECTACION_PARCIAL', 20, reason), 409);
  const resolved = await until('publicación de la resolución real', () => outboxIncidente(incidencia, 'resuelta').out);
  check('Broker: evidencias.incidencia-resuelta.v1 tiene suscriptores', JSON.parse(resolved).payload.incidencia_id === incidencia);
  await publishEnvelope('evidencias.incidencia-resuelta.v1', JSON.parse(resolved));
  const tx = await transaccion(prestamo, 'RETENCION_GARANTIA');
  check('Pagos: retiene 20 sin devolver saldo antes de confirmación', tx.monto === 20 &&
    !(await transacciones(prestamo)).some((t) => t.tipo === 'DEVOLUCION_GARANTIA'));
  await aviso(LENDER, 'Incidencia resuelta', 'el prestamista', (n) => n.origen_id === incidencia && n.mensaje === reason);
  await aviso(LENDER, 'Garantía retenida', 'el prestamista');
  await until('que Préstamos libere el cierre', async () => (await loan(prestamo)).estado_detalle === 'DEVOLUCION_REGISTRADA');
  expect('Préstamos: resuelta la incidencia, se puede finalizar', await call('POST', `/prestamos/${prestamo}/confirmacion-devolucion`, LENDER), 200, (b) => b.estado === 'FINALIZADO');
  const dev = await transaccion(prestamo, 'DEVOLUCION_GARANTIA');
  check('Pagos: devuelve exactamente 30 una vez tras el cierre', dev.monto === 30 &&
    (await transacciones(prestamo)).filter((t) => t.tipo === 'DEVOLUCION_GARANTIA').length === 1);
  check('Pagos: la redifusión de la resolución no duplica la retención',
    (await transacciones(prestamo)).filter((t) => t.tipo === 'RETENCION_GARANTIA').length === 1);
  await aviso(BORROWER, 'Garantía devuelta', 'el prestatario', (n) => fecha(n) >= started && n.mensaje.includes('30'));
}

async function incidenciaConRetencionTotal() {
  historia('Garantía: afectación total autorizada por Evidencias');
  const { prestamo } = await activo(Date.now() - HOUR, Date.now() + 23 * HOUR, 20);
  expect('Garantía total: se registra el objeto devuelto', await call('POST', `/prestamos/${prestamo}/devolucion`, BORROWER), 200);
  const body = incidentBody(prestamo);
  const id = body.clave_idempotencia;
  expect('Evidencias: registra la incidencia de afectación total', await reportar(body), 201);
  await until('que Préstamos proyecte la incidencia total', async () => (await loan(prestamo)).estado_detalle === 'PENDIENTE_INCIDENCIA');
  expect('Evidencias: inicia la revisión de la afectación total', await administrar(id, 'revision'), 200);
  expect('Evidencias: autoriza el saldo total pactado', await resolver(id, 'AFECTACION_TOTAL', 50), 200);
  const aplicada = await transaccion(prestamo, 'RETENCION_GARANTIA');
  check('Pagos: registra retención total de los 50 autorizados', aplicada.monto === 50);
  await until('que Préstamos permita el cierre tras afectación total', async () => (await loan(prestamo)).estado_detalle === 'DEVOLUCION_REGISTRADA');
  expect('Garantía total: el prestamista confirma la devolución', await call('POST', `/prestamos/${prestamo}/confirmacion-devolucion`, LENDER), 200);
  await until('que Pagos procese el cierre con saldo cero', async () => sql('lendup_pagos',
    `select count(*) from lendup_pagos.guarantee_closures where loan_id='${prestamo}'`).out === '1');
  check('Pagos: saldo cero tras el cierre sin devolución adicional', !(await transacciones(prestamo)).some((t) => t.tipo === 'DEVOLUCION_GARANTIA'));
}

async function concurrenciaYOutbox() {
  historia('Evidencias: carrera entre reporte, resolución y cierre con RabbitMQ detenido');
  const { prestamo } = await activo(Date.now() - HOUR, Date.now() + 23 * HOUR, 20);
  const returnPath = `/prestamos/${prestamo}/confirmacion-devolucion`;
  expect('Préstamos: registra la devolución física', await call('POST', `/prestamos/${prestamo}/devolucion`, BORROWER), 200);
  const a = incidentBody(prestamo), b = incidentBody(prestamo), c = incidentBody(prestamo);
  const first = a.clave_idempotencia, second = b.clave_idempotencia, third = c.clave_idempotencia;
  compose('pause', 'rabbitmq');
  try {
    expect('Evidencias: persiste el reporte aunque RabbitMQ esté detenido', await reportar(a), 201);
    check('Evidencias: el reporte y el Outbox existen antes de publicarse',
      evidenceSql(`select count(*) from lendup_evidencias.incidencias i join lendup_evidencias.outbox_events e on e.aggregate_id=i.id where i.id='${first}' and e.published_at is null`).out === '1');
    check('Préstamos: el reporte aún no está proyectado',
      (await loan(prestamo)).estado_detalle === 'DEVOLUCION_REGISTRADA');
    expect('Préstamos: el reporte persistido bloquea el cierre durante la ventana del Outbox',
      await call('POST', returnPath, LENDER), 409);
    expect('Evidencias: el préstamo admite una segunda incidencia', await reportar(b, BORROWER), 201);
    expect('Evidencias: el préstamo admite una tercera incidencia', await reportar(c), 201);
    for (const id of [first, second, third]) {
      expect('Evidencias: cada incidencia se revisa antes de resolverse', await administrar(id, 'revision'), 200);
    }
    const concurrent = await Promise.all([resolver(first, 'AFECTACION_PARCIAL', 30), resolver(second, 'AFECTACION_PARCIAL', 30)]);
    check('Evidencias: dos resoluciones concurrentes de 30 no superan la garantía de 50',
      concurrent.filter((r) => r.status === 200).length === 1 && concurrent.filter((r) => r.status === 400).length === 1,
      concurrent.map((r) => r.status).join(', '));
    const rejected = concurrent[0].status === 400 ? first : second;
    const accepted = rejected === first ? second : first;
    expect('Evidencias: puede resolver sin afectación con la otra decisión registrada',
      await resolver(third, 'SIN_AFECTACION', 0), 200, (x) => Number(x.saldo_garantia_previsto) === 20);
    const [close, decision] = await Promise.all([call('POST', returnPath, LENDER), resolver(rejected, 'AFECTACION_TOTAL', 20)]);
    expect('Evidencias: la afectación total autoriza solo el saldo restante', decision, 200, (x) => Number(x.saldo_garantia_previsto) === 0);
    check('Préstamos: el intento concurrente se serializa con la última resolución', [200, 409].includes(close.status), `HTTP ${close.status}`);
    if (close.status === 409) expect('Préstamos: reintenta el cierre cuando todas están resueltas', await call('POST', returnPath, LENDER), 200);
    const cierre = sql('lendup_prestamos', `select payload from lendup_prestamos.outbox_events where aggregate_id=uuid_to_bin('${prestamo}') and event_type='PrestamoFinalizado'`);
    check('Préstamos: registra un cierre con las tres decisiones antes de recibir sus eventos',
      cierre.ok && [first, second, third].every((id) => cierre.out.includes(id)));
    expect('Evidencias: bloquea un nuevo reporte después del sellado', await reportar(incidentBody(prestamo)), 409);
    check('Pagos: todavía no devuelve la garantía con la mensajería detenida',
      !(await transacciones(prestamo)).some((t) => t.tipo === 'DEVOLUCION_GARANTIA'));
    await until('un reintento persistido en el Outbox de Evidencias', () => Number(evidenceSql(
      `select count(*) from lendup_evidencias.outbox_events where aggregate_id in ('${accepted}','${rejected}') and attempts>0 and published_at is null`).out) > 0);
    check('Evidencias: el Outbox agenda el reintento sin perder la decisión', true);
  } finally {
    compose('unpause', 'rabbitmq');
  }
  const liquidado = await until('las dos retenciones exactas tras recuperar RabbitMQ', async () => {
    const list = await transacciones(prestamo);
    const values = list.filter?.((t) => t.tipo === 'RETENCION_GARANTIA').map((t) => t.monto).sort((x, y) => x - y);
    return values?.length === 2 && { list, values };
  }, 90);
  check('Pagos: retiene 30 y 20 exactamente una vez sin devolver saldo',
    liquidado.values.join(',') === '20,30' && !liquidado.list.some((t) => t.tipo === 'DEVOLUCION_GARANTIA'));
  await aviso(LENDER, 'Incidencia resuelta', 'el prestamista', (n) => n.origen_id === third);
  await inboxYPersistencia(prestamo, third);
}

async function inboxYPersistencia(prestamo, incidencia) {
  historia('Evidencias: Inbox idempotente, versiones atrasadas y persistencia tras reinicio');
  const proyeccion = () => evidenceSql(`select estado, state_version from lendup_evidencias.loan_projection where prestamo_id='${prestamo}'`).out;
  const final = await until('la proyección FINALIZADO en el Inbox', () => {
    const row = proyeccion();
    return row.startsWith('FINALIZADO\t') && row;
  });
  const out = sql('lendup_prestamos', `
    select json_object('event_id',bin_to_uuid(id),'event_type',event_type,'event_version',event_version,
      'aggregate_id',bin_to_uuid(aggregate_id),'aggregate_version',aggregate_version,
      'occurred_at',concat(date_format(occurred_at,'%Y-%m-%dT%H:%i:%s.%f'),'Z'),'correlation_id',correlation_id,'payload',payload)
    from lendup_prestamos.outbox_events where aggregate_id=uuid_to_bin('${prestamo}') and event_type='PrestamoCreado'`);
  check('Evidencias: existe un evento real de creación para repetir', out.ok && out.out.length > 0);
  const created = JSON.parse(out.out);
  const older = { ...created, event_id: randomUUID() };
  const testExchange = `e2e.evidence.inbox.${randomUUID()}`;
  const queue = 'evidence.events.v1', route = 'prestamos.creado.v1';
  const inboxCount = (id) => evidenceSql(`select count(*) from lendup_evidencias.inbox_events where id='${id}'`).out;
  check('Evidencias: el Inbox ya confirmó exactamente una vez la creación real', inboxCount(created.event_id) === '1');
  await rabbit('PUT', `/exchanges/%2F/${testExchange}`, { type: 'direct', durable: false });
  try {
    await rabbit('POST', `/bindings/%2F/e/${testExchange}/q/${queue}`, { routing_key: route });
    for (const message of [created, older]) {
      const response = await rabbit('POST', `/exchanges/%2F/${testExchange}/publish`, {
        routing_key: route, payload: JSON.stringify(message), payload_encoding: 'string', properties: { content_type: 'application/json' },
      });
      check('RabbitMQ: la redifusión de prueba llega al Inbox de Evidencias', response.routed);
    }
    await until('la confirmación del evento con versión antigua', () => inboxCount(older.event_id) === '1');
    check('Evidencias: la entrega repetida conserva una sola fila por ID de evento', inboxCount(created.event_id) === '1');
    check('Evidencias: una creación atrasada no revierte FINALIZADO', proyeccion() === final);
  } finally {
    await rabbit('DELETE', `/exchanges/%2F/${testExchange}`);
  }
  compose('restart', 'evidence');
  await until('que Evidencias vuelva después del reinicio', async () =>
    fetch('http://localhost:8088/health').then((r) => r.ok).catch(() => false), 90);
  expect('Evidencias: conserva la resolución del incidente tras reiniciar', await call('GET', `/incidencias/${incidencia}`, BORROWER), 200,
    (b) => b.estado === 'RESUELTA' && b.decision_garantia === 'SIN_AFECTACION');
  check('Evidencias: conserva el Inbox y la proyección tras reiniciar', inboxCount(older.event_id) === '1' && proyeccion() === final);
}

async function recuperacionConIncidencia() {
  historia('Evidencias: recuperación física con reporte simultáneo y devolución del saldo');
  const { prestamo, reserva } = await reservar(Date.now() - HOUR, Date.now() + 23 * HOUR);
  await pagarTodo(prestamo, 20);
  expect('Préstamos: registra entrega para recuperación', await call('POST', `/prestamos/${prestamo}/entrega`, LENDER), 200);
  const cancellation = await call('POST', `/reservas/${reserva}/cancelacion`, BORROWER, { motivo_cancelacion: 'Se coordina recuperar el objeto ya entregado.' });
  expect('Reservas: acepta solicitud de cancelación durante la entrega', cancellation, 200);
  await until('la recuperación pendiente', async () => (await loan(prestamo)).estado_detalle === 'RECUPERACION_PENDIENTE');
  const partial = incidentBody(prestamo);
  expect('Evidencias: admite reportes durante la recuperación física', await reportar(partial), 201);
  expect('Evidencias: revisa el daño durante la recuperación', await administrar(partial.clave_idempotencia, 'revision'), 200);
  expect('Evidencias: autoriza retener 15 de la garantía', await resolver(partial.clave_idempotencia, 'AFECTACION_PARCIAL', 15), 200);
  await until('que Préstamos proyecte la primera decisión de recuperación', () => sql('lendup_prestamos',
    `select resolved from lendup_prestamos.loan_incident_projection where incident_id='${partial.clave_idempotencia}'`).out === '1');
  const data = incidentBody(prestamo);
  const id = data.clave_idempotencia;
  const confirmPath = `/prestamos/${prestamo}/confirmacion-recuperacion`;
  const [report, close] = await Promise.all([reportar(data), call('POST', confirmPath, LENDER)]);
  check('Evidencias y Préstamos: solo se acepta el reporte o el cierre simultáneo',
    (report.status === 201 && close.status === 409) || (report.status === 409 && close.status === 200),
    `reporte HTTP ${report.status}, confirmación HTTP ${close.status}`);
  if (report.status === 201) {
    expect('Evidencias: revisa la incidencia durante la recuperación', await administrar(id, 'revision'), 200);
    expect('Evidencias: cierra sin afectación el reporte concurrente', await resolver(id, 'SIN_AFECTACION', 0), 200);
    await until('que Préstamos proyecte la resolución de recuperación', () => sql('lendup_prestamos',
      `select resolved from lendup_prestamos.loan_incident_projection where incident_id='${id}'`).out === '1');
    expect('Préstamos: confirma la recuperación física tras la resolución', await call('POST', confirmPath, LENDER), 200);
  }
  const refund = await transaccion(prestamo, 'DEVOLUCION_GARANTIA');
  check('Pagos: devuelve 35 después de la recuperación y conserva la retención de 15', refund.monto === 35 &&
    (await transacciones(prestamo)).some((t) => t.tipo === 'RETENCION_GARANTIA' && t.monto === 15));
}

async function cierreTrasRollback() {
  historia('Evidencias: indisponibilidad, rollback de Préstamos y recuperación de un sello huérfano');
  const { prestamo } = await activo(Date.now() - HOUR, Date.now() + 23 * HOUR, 20);
  const path = `/prestamos/${prestamo}/confirmacion-devolucion`;
  expect('Préstamos: registra la devolución antes de probar fallos de cierre',
    await call('POST', `/prestamos/${prestamo}/devolucion`, BORROWER), 200);
  const snapshot = async () => (await call('GET', '/prestamos', LENDER)).body.find((row) => row.id === prestamo);
  const outboxCount = () => sql('lendup_prestamos',
    `select count(*) from lendup_prestamos.outbox_events where aggregate_id=uuid_to_bin('${prestamo}') and event_type='PrestamoFinalizado'`).out;
  compose('stop', 'evidence');
  try {
    expect('Préstamos: rechaza el cierre si Evidencias está indisponible', await call('POST', path, LENDER), 503);
    check('Préstamos: conserva estado y Outbox ante la indisponibilidad',
      (await snapshot()).estado_detalle === 'DEVOLUCION_REGISTRADA' && outboxCount() === '0');
  } finally {
    compose('start', 'evidence');
  }
  await until('que Evidencias vuelva para la prueba de rollback', async () =>
    fetch('http://localhost:8088/health').then((r) => r.ok).catch(() => false), 90);
  const fault = `e2e_cierre_${prestamo.replaceAll('-', '')}`;
  const ddl = `alter table lendup_prestamos.prestamos add constraint ${fault}
    check (id <> X'${prestamo.replaceAll('-', '')}' or estado <> 'FINALIZADO')`;
  const installed = sql('lendup_prestamos', ddl);
  check('MySQL: instala un fallo de escritura acotado al préstamo de prueba', installed.ok, installed.out);
  try {
    const close = await call('POST', path, LENDER);
    check('Préstamos: falla al persistir el cierre después de que Evidencias sella',
      [409, 500].includes(close.status) && evidenceSql(
        `select count(*) from lendup_evidencias.cierres_incidencias where prestamo_id='${prestamo}' and sellado=1 and sello_id is not null`).out === '1',
      `HTTP ${close.status}`);
    check('Préstamos: el rollback conserva la devolución registrada y no crea evento',
      (await snapshot()).estado_detalle === 'DEVOLUCION_REGISTRADA' && outboxCount() === '0');
    check('Pagos: el rollback no genera devolución de garantía',
      (await transacciones(prestamo)).every((t) => t.tipo !== 'DEVOLUCION_GARANTIA'));
  } finally {
    const removed = sql('lendup_prestamos', `alter table lendup_prestamos.prestamos drop check ${fault}`);
    if (!removed.ok) throw new Error(`No se pudo retirar la restricción temporal ${fault}`);
  }
  const report = incidentBody(prestamo);
  const incident = report.clave_idempotencia;
  expect('Evidencias: un reporte recupera el sello huérfano sin reintentar el cierre',
    await reportar(report), 201, (b) => b.id === incident);
  expect('Préstamos: el reporte recuperado vuelve a bloquear el cierre', await call('POST', path, LENDER), 409);
  expect('Evidencias: revisa la incidencia tras recuperar la admisión', await administrar(incident, 'revision'), 200);
  expect('Evidencias: resuelve sin afectación tras el rollback', await resolver(incident, 'SIN_AFECTACION', 0), 200);
  await until('que Préstamos proyecte la resolución tras el rollback', async () =>
    sql('lendup_prestamos',
      `select resolved from lendup_prestamos.loan_incident_projection where incident_id='${incident}'`
    ).out === '1' &&
    (await snapshot()).estado_detalle === 'DEVOLUCION_REGISTRADA');
  const finished = await call('POST', path, LENDER);
  expect('Préstamos: el siguiente cierre confirma la devolución', finished, 200, (b) => b.estado === 'FINALIZADO');
  expect('Préstamos: reintentar un cierre confirmado devuelve el mismo resultado', await call('POST', path, LENDER), 200,
    (b) => b.estado === 'FINALIZADO' && b.devolucion_confirmada_en === finished.body.devolucion_confirmada_en);
  check('Préstamos: queda un único evento de finalización tras reintentar', outboxCount() === '1');
  expect('Evidencias: el cierre confirmado impide reabrir la admisión', await reportar(incidentBody(prestamo)), 409);
  const refund = await transaccion(prestamo, 'DEVOLUCION_GARANTIA');
  check('Pagos: devuelve los 50 íntegros tras el cierre recuperado', refund.monto === 50);
}

const listo = (puerto) => fetch(`http://localhost:${puerto}/actuator/health/readiness`).then((r) => r.ok).catch(() => false);
async function resiliencia() {
  historia('9. Un servicio caído no detiene a los demás y nada se pierde');
  const publicacion = await publicar();
  compose('stop', 'loans');
  const caido = await call('GET', '/prestamos', BORROWER);
  check('Gateway: con Préstamos caído responde 503 controlado', caido.status === 503, `HTTP ${caido.status} ${caido.body.error ?? ''}`);
  expect('Pagos: sigue funcionando', await call('GET', '/medios-pago', BORROWER), 200);
  expect('Notificaciones: sigue funcionando', await call('GET', '/notificaciones', BORROWER), 200);
  const s1 = await solicitar(Date.now() + HOUR, Date.now() + 25 * HOUR, publicacion);
  const r1 = await call('POST', `/solicitudes/${s1.body.id}/aceptacion`, LENDER);
  expect('Reservas: confirma una reserva aunque Préstamos esté caído', r1, 201);
  await sleep(2500);
  compose('start', 'loans');
  const creado = await until('que Préstamos vuelva y cree el préstamo', async () => { const r = await call('GET', '/prestamos', BORROWER); return r.status === 200 && r.body.find((p) => p.reserva_id === r1.body.id); }, 120);
  check('Préstamos: al volver procesó el evento que esperaba en su cola', creado.estado === 'RESERVADO', creado.estado);

  compose('stop', 'notifications', 'payments');
  expect('Gateway: con Pagos caído responde 503 controlado', await call('GET', '/medios-pago', BORROWER), 503);
  expect('Gateway: con Notificaciones caído responde 503 controlado', await call('GET', '/notificaciones', BORROWER), 503);
  const s2 = await solicitar(Date.now() + 30 * HOUR, Date.now() + 54 * HOUR, publicacion);
  expect('Reservas: se puede solicitar sin Notificaciones (CRN-04)', s2, 201);
  const r2 = await call('POST', `/solicitudes/${s2.body.id}/aceptacion`, LENDER);
  const p2 = await until('que Préstamos cree el préstamo', async () => (await call('GET', '/prestamos', BORROWER)).body.find?.((p) => p.reserva_id === r2.body.id));
  check('Préstamos: crea el préstamo sin Pagos ni Notificaciones', p2.estado === 'RESERVADO');
  compose('start', 'notifications', 'payments');
  await until('que vuelvan Pagos y Notificaciones', async () => (await listo(8082)) && (await listo(8083)), 120);
  await aviso(LENDER, 'Nueva solicitud', 'el prestamista, al volver el servicio,', (n) => n.origen_id === s2.body.id);
  await cobrar('/pagos', tarifaBody(p2.id, 20), 'tarifa del préstamo creado mientras Pagos estaba caído');
}

async function independenciaDeDatos() {
  historia('10. Independencia de datos');
  const servicios = ['identidad', 'catalogo', 'reservas', 'prestamos', 'pagos', 'notificaciones', 'reputacion', 'evidencias'].map((s) => `lendup_${s}`);
  const tabla = { lendup_identidad: 'usuarios', lendup_catalogo: 'publicaciones', lendup_reservas: 'reservas', lendup_prestamos: 'prestamos', lendup_pagos: 'garantias', lendup_notificaciones: 'notificaciones', lendup_reputacion: 'calificaciones', lendup_evidencias: 'incidencias' };
  for (const propio of ['lendup_prestamos', 'lendup_pagos', 'lendup_notificaciones', 'lendup_evidencias']) {
    const r = sql(propio, `select count(*) from ${propio}.${tabla[propio]}`);
    check(`MySQL: ${propio} lee su propio esquema`, r.ok && Number(r.out) > 0, `${r.out} filas`);
    const ajenos = servicios.filter((s) => s !== propio).map((s) => [s, sql(propio, `select count(*) from ${s}.${tabla[s]}`)]);
    check(`MySQL: ${propio} no puede leer ninguno de los otros ${ajenos.length} esquemas`, ajenos.every(([, x]) => !x.ok && /denied/.test(x.out)), ajenos[0][1].out);
  }
  check('MySQL: Evidencias está en la revisión de Alembic esperada',
    evidenceSql('select version_num from lendup_evidencias.alembic_version').out === '0005_incident_seal_generation');
}

// Rutas de services/api/endpoints.ts del frontend y a qué servicio deben llegar por el gateway.
async function rutasDelFrontend() {
  historia('11. Cada ruta del frontend llega a su microservicio por el gateway');
  const x = randomUUID(), y = randomUUID();
  const rutas = {
    Identidad: ['GET /universidades', 'POST /estudiantes', 'GET /estudiantes/me', 'PUT /estudiantes/me', 'POST /estudiantes/me/verificacion', 'POST /estudiantes/me/aceptacion-terminos', `GET /estudiantes/${x}`],
    Reservas: ['POST /solicitudes', 'GET /solicitudes', `GET /solicitudes/${x}`, `POST /solicitudes/${x}/aceptacion`, `POST /solicitudes/${x}/rechazo`, `POST /solicitudes/${x}/cancelacion`, 'GET /reservas', `POST /reservas/${x}/cancelacion`, `GET /reservas/${x}/contacto`],
    Préstamos: [`POST /prestamos/${x}/entrega`, `POST /prestamos/${x}/recepcion`, `POST /prestamos/${x}/extensiones`, `POST /prestamos/${x}/extensiones/${y}/respuesta`, `POST /prestamos/${x}/reprogramaciones`, `POST /prestamos/${x}/reprogramaciones/${y}/respuesta`,
    `POST /prestamos/${x}/devolucion`, `POST /prestamos/${x}/confirmacion-devolucion`, 'GET /prestamos', 'GET /calendario', `GET /prestamos/${x}`, `POST /prestamos/${x}/extensiones/cotizacion`, `GET /prestamos/${x}/cotizacion-pago`],
    Pagos: ['GET /medios-pago', 'POST /pagos', 'POST /garantias', `GET /prestamos/${x}/transacciones`],
    Reputación: [`POST /prestamos/${x}/calificaciones`, `GET /estudiantes/${x}/reputacion`],
    Notificaciones: ['GET /notificaciones', `PATCH /notificaciones/${x}`],
    Catálogo: ['GET /catalogo/categorias', 'GET /catalogo/publicaciones', 'GET /catalogo/mis-publicaciones'],
  };
  for (const [servicio, lista] of Object.entries(rutas)) {
    const malas = [];
    for (const r of lista) {
      const [metodo, ruta] = r.split(' ');
      const res = await call(metodo, ruta, BORROWER, metodo === 'GET' ? undefined : {});
      if (res.status === 418 || res.status >= 500 || (res.status === 404 && /No static resource|Cannot (GET|POST|PUT|PATCH)/i.test(JSON.stringify(res.body)))) malas.push(`${r} -> ${res.status}`);
    }
    check(`${servicio}: ${lista.length} rutas llegan a su servicio`, malas.length === 0, malas.join('; ') || 'ninguna al monolito');
  }
  const evidencia = [
    ['POST', `/prestamos/${x}/evidencias`, 400], ['POST', `/prestamos/${x}/analisis-evidencias`, 422],
    ['GET', '/incidencias', 200], ['GET', '/admin/incidencias', 403],
  ];
  const estados = await Promise.all(evidencia.map(async ([method, path]) =>
    (await call(method, path, BORROWER, method === 'GET' ? undefined : {})).status));
  check('Evidencias: las rutas del frontend llegan al servicio real a través del Gateway',
    estados.every((status, i) => status === evidencia[i][2]), estados.join(', '));
}

async function outboxes() {
  historia('12. Nada quedó sin entregar');
  const pendientes = {
    lendup_reservas: 'select count(*) from lendup_reservas.outbox_events where published_at is null',
    lendup_prestamos: 'select count(*) from lendup_prestamos.outbox_events where published_at is null',
    lendup_pagos: 'select count(*) from lendup_pagos.outbox_events where published_at is null',
    lendup_reputacion: 'select count(*) from lendup_reputacion.outbox_events where published_at is null',
    lendup_evidencias: 'select count(*) from lendup_evidencias.outbox_events where published_at is null',
  };
  for (const [esquema, consulta] of Object.entries(pendientes)) {
    const r = await until(`el outbox de ${esquema} en 0`, async () => { const q = sql(esquema, consulta); return q.ok && q.out === '0' && q; }, 45).catch(() => sql(esquema, consulta));
    check(`${esquema}: outbox sin eventos pendientes`, r.ok && r.out === '0', `${r.out} pendientes`);
  }
}

// --- ejecución ----------------------------------------------------------------------------------------------------
let failed = null, deadBefore = {};
const deadLetters = async () => Object.fromEntries((await rabbit('GET', '/queues')).filter((q) => q.name.endsWith('.dlq')).map((q) => [q.name, q.messages ?? 0]));
try {
  await until('que arranquen todos los servicios', async () => {
    const java = await Promise.all([8081, 8082, 8083, 8087, 8090].map(listo));
    const otros = await Promise.all(['http://localhost:8085/health', 'http://localhost:8084/health', 'http://localhost:8086/health/ready', 'http://localhost:8088/health', 'http://localhost:9099/'].map((u) => fetch(u).then((r) => r.ok).catch(() => false)));
    return [...java, ...otros].every(Boolean);
  }, 180);
  await until('las colas de Evidencias', async () => {
    const queues = await rabbit('GET', '/queues');
    return ['evidence.events.v1', 'evidence.events.v1.dlq'].every((name) => queues.some((q) => q.name === name));
  });
  if (compose('exec', '-T', 'payments', 'printenv', 'MERCADOPAGO_MODE').trim() !== 'simulado') {
    throw new Error('La suite requiere el modo simulado de Mercado Pago');
  }
  await rabbit('PUT', `/queues/%2F/${SPY}`, { durable: false, arguments: { 'x-max-length': 2000 } });
  await rabbit('POST', `/bindings/%2F/e/lendup.domain.events/q/${SPY}`, { routing_key: '#' });
  await rabbit('DELETE', `/queues/%2F/${SPY}/contents`);
  deadBefore = await deadLetters();
  for (const s of [identidadYCatalogo, solicitudes, cicloCompleto, cancelacion, cancelacionRechazada, cambiosDeFecha, vencimiento,
    retencionExpirada, incidencias, incidenciaConRetencionTotal, concurrenciaYOutbox, recuperacionConIncidencia, cierreTrasRollback, resiliencia,
    independenciaDeDatos, rutasDelFrontend, outboxes]) await s();
} catch (e) { failed = e; console.error('\n' + e.message); }

historia('13. Broker');
const seen = {}, incumplen = [];
for (const m of await rabbit('POST', `/queues/%2F/${SPY}/get`, { count: 2000, ackmode: 'ack_requeue_true', encoding: 'auto' })) {
  seen[m.routing_key] = (seen[m.routing_key] ?? 0) + 1;
  incumplen.push(...revisar(m.routing_key, JSON.parse(m.payload)));
}
await sleep(6000); // la API de administración refresca sus contadores cada 5 s
const queues = (await rabbit('GET', '/queues')).filter((q) => q.name !== SPY);
const dead = queues.filter((q) => q.name.endsWith('.dlq') && q.messages > (deadBefore[q.name] ?? 0));
console.log('\nEventos por routing key:'); Object.entries(seen).sort().forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
if (!failed) try {
  check('Ninguna DLQ recibió mensajes durante la prueba', dead.length === 0, dead.map((q) => `${q.name}=${q.messages}`).join(', ') || 'ninguno');
  const deadLettersNow = queues.filter((q) => q.name.endsWith('.dlq'));
  check('Las seis DLQ están vacías', deadLettersNow.length === 6 && deadLettersNow.every((q) => q.messages === 0));
  check('Evidencias: sus colas de mensajes y DLQ existen y están vacías',
    ['evidence.events.v1', 'evidence.events.v1.dlq'].every((name) => queues.some((q) => q.name === name && q.messages === 0)));
  check('Evidencias: el Broker observó los tres tipos de evento del productor real',
    ['evidencia-registrada', 'incidencia-reportada', 'incidencia-resuelta'].every((tipo) => seen[`evidencias.${tipo}.v1`] > 0));
  const propias = ['prestamos.creado.v1', 'prestamos.objeto-entregado.v1', 'prestamos.activado.v1', 'prestamos.extension-solicitada.v1', 'prestamos.extension-aceptada.v1', 'prestamos.extension-rechazada.v1', 'prestamos.reprogramacion-propuesta.v1', 'prestamos.reprogramacion-rechazada.v1',
    'prestamos.fecha-devolucion-actualizada.v1', 'prestamos.devolucion-registrada.v1', 'prestamos.vencido.v1', 'prestamos.finalizado.v1', 'prestamos.cancelado.v1', 'prestamos.cancelacion-rechazada.v1', 'prestamos.periodo-liberado.v1',
    'pagos.pago-confirmado.v1', 'pagos.pago-rechazado.v1', 'pagos.garantia-constituida.v1', 'pagos.tarifa-liberada.v1', 'pagos.garantia-devuelta.v1', 'pagos.garantia-retenida.v1', 'pagos.reembolso-procesado.v1'];
  const faltan = propias.filter((k) => !seen[k]);
  const coordinadas = ['prestamos.extension-retencion-solicitada.v1', 'prestamos.extension-confirmacion-solicitada.v1',
    'reservas.extension-retenida.v1', 'reservas.extension-ocupacion-confirmada.v1',
    'reservas.extension-retencion-rechazada.v1', 'prestamos.recuperacion-pendiente.v1'];
  const coordinadasFaltantes = coordinadas.filter((k) => !seen[k]);
  check(`Los ${Object.values(seen).reduce((s, n) => s + n, 0)} eventos observados cumplen el esquema del productor y lo que exige cada consumidor`, incumplen.length === 0, [...new Set(incumplen)].slice(0, 4).join('; ') || 'sin diferencias');
  const ejemplos = revisarEjemplos();
  check(`Los ${ejemplos.total} ejemplos de los contratos cumplen su esquema`, ejemplos.errors.length === 0, ejemplos.errors.slice(0, 3).join('; ') || 'sin diferencias');
  check(`Préstamos y Pagos publicaron ${propias.length} tipos de evento distintos`, faltan.length === 0, faltan.join(', ') || 'todos');
  check(`Se observaron ${coordinadas.length} tipos de evento de la coordinación`, coordinadasFaltantes.length === 0, coordinadasFaltantes.join(', ') || 'todos');
} catch (e) { failed = e; }

mkdirSync(resolve(root, 'reportes'), { recursive: true });
const ok = results.filter((r) => r.ok).length;
const reportPath = resolve(root, 'reportes', 'e2e-ocho-microservicios.md');
writeFileSync(reportPath, [`# Prueba de punta a punta de LendUp`, '', `Fecha (Lima) ${new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'America/Lima' }).format(new Date())}`, `Resultado **${failed ? 'FALLÓ: ' + failed.message : `${ok}/${results.length} verificaciones en verde`}**`, '',
  'Identidad, Catálogo, Reservas, Préstamos, Pagos, Notificaciones, Reputación y Evidencias se ejecutaron a través del Gateway. MySQL y RabbitMQ son reales. Firebase usa el emulador oficial. Mercado Pago, Cloudinary y Gemini tienen dobles locales.', '',
  ...[...new Set(results.map((r) => r.story))].flatMap((s) => [`## ${s}`, '', '| Verificación | Resultado | Detalle |', '|---|---|---|', ...results.filter((r) => r.story === s).map((r) => `| ${r.name} | ${r.ok ? 'OK' : 'FALLA'} | ${r.detail.replaceAll('|', '/')} |`), '']),
  '## Eventos que pasaron por RabbitMQ', '', '| Routing key | Cantidad |', '|---|---|', ...Object.entries(seen).sort().map(([k, n]) => `| \`${k}\` | ${n} |`), '',
  '## Colas', '', '| Cola | Mensajes pendientes |', '|---|---|', ...queues.map((q) => `| \`${q.name}\` | ${q.messages ?? 0} |`), ''].join('\n'));
console.log(`\n${failed ? 'FALLÓ' : 'TODO EN VERDE'}: ${ok}/${results.length} verificaciones. Reporte: ${reportPath}`);
process.exit(failed ? 1 : 0);
