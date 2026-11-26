// Prueba de punta a punta de todo LendUp por el API Gateway, con los servicios reales. Los eventos nacen de las peticiones
// HTTP; solo los de Evidencias se publican a mano, porque su microservicio todavía no existe.
// Deja un reporte en reportes/e2e.md.   Uso: node scripts/e2e.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { revisar, revisarEjemplos } from './contratos.mjs';
import { BORROWER, HOUR, LENDER, OUTSIDER, SPY, call, check, compose, emailOf, ensureUser, env, expect, firebaseAccount, historia, ids, lima, publish, rabbit, results, root, sleep, sql, token, until } from './lib.mjs';

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
  expect('Catálogo: categorías públicas sin sesión', await call('GET', '/catalogo/categorias', null), 200, (b) => b.length >= 8);
  const publicacion = await publicar();
  expect('Catálogo: la publicación es visible', await call('GET', `/catalogo/publicaciones/${publicacion}`, null), 200, (b) => b.propietarioUsuarioId === ids[LENDER]);
  expect('Reservas: nadie puede solicitar su propio objeto', await (async () => {
    const desde = lima(Date.now() + 24 * HOUR), hasta = lima(Date.now() + 48 * HOUR);
    const s = (await call('GET', `/catalogo/publicaciones/${publicacion}/snapshot?desde=${desde}&hasta=${hasta}`, null)).body;
    return call('POST', '/solicitudes', LENDER, { publicacion_id: publicacion, desde, hasta, aceptacion_condiciones: { snapshot_id: s.snapshot_id, snapshot_hash: s.snapshot_hash, aceptada: true } });
  })(), 409);
  const protegidas = { Préstamos: '/prestamos', Pagos: '/medios-pago', Notificaciones: '/notificaciones' };
  for (const [servicio, ruta] of Object.entries(protegidas)) {
    expect(`${servicio}: sin token responde 401`, await call('GET', ruta, null), 401);
    expect(`${servicio}: token inválido responde 401`, await call('GET', ruta, 'raw:no-es-un-token'), 401);
  }
  await firebaseAccount('e2e-sin-verificar', false);
  for (const [servicio, ruta] of Object.entries(protegidas)) expect(`${servicio}: correo sin verificar responde 403`, await call('GET', ruta, 'e2e-sin-verificar'), 403);
  await firebaseAccount('e2e-sin-registro');
  for (const servicio of ['Préstamos', 'Notificaciones']) {
    const r = await call('GET', protegidas[servicio], 'e2e-sin-registro');
    check(`${servicio}: cuenta de Firebase sin registro en LendUp no entra`, [401, 403, 404].includes(r.status), `HTTP ${r.status}`);
  }
  for (const ruta of [`/internal/v1/prestamos/reservas/${randomUUID()}/participantes/${randomUUID()}/contacto`, `/internal/v1/identidad/firebase/${BORROWER}`, `/internal/v1/catalogo/publicaciones/${publicacion}/snapshot`]) {
    const r = await call('GET', ruta, BORROWER, undefined, 'http://localhost:8090');
    check(`Gateway: no publica ${ruta.split('/').slice(0, 4).join('/')}`, r.status === 404, `HTTP ${r.status}`);
  }
  const propio = await call('GET', '/prestamos', LENDER);
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
  const { reserva, prestamo } = await reservar(Date.now() - HOUR, Date.now() + 47 * HOUR);
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
  expect('Préstamos: el prestamista la acepta', await call('POST', `/prestamos/${prestamo}/extensiones/${ext.body.id}/respuesta`, LENDER, { estado: 'ACEPTADA_PENDIENTE_PAGO' }), 200);
  await aviso(BORROWER, 'Extensión aceptada', 'el prestatario', (n) => n.origen_id === ext.body.id);
  await pagar('/pagos', { prestamo_id: prestamo, cambio_fecha_prestamo_id: ext.body.id, tipo: 'PAGO_EXTENSION', monto: 40, medio_pago_seleccionado: 'MERCADO_PAGO', clave_idempotencia: `ext-${ext.body.id}` }, 'extensión');
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
  historia('5. Cancelación rechazada porque ya se entregó');
  const { reserva, prestamo } = await reservar(Date.now() - HOUR, Date.now() + 23 * HOUR);
  await pagarTodo(prestamo, 20);
  expect('Préstamos: entrega registrada', await call('POST', `/prestamos/${prestamo}/entrega`, LENDER), 200);
  expect('Reservas: cancelación solicitada', await call('POST', `/reservas/${reserva}/cancelacion`, BORROWER, { motivo_cancelacion: 'Cambio de planes' }), 200);
  await until('que Reservas vuelva a CONFIRMADA', async () => (await call('GET', '/reservas', BORROWER)).body.find?.((x) => x.id === reserva && x.estado === 'CONFIRMADA'));
  check('Reservas: volvió a CONFIRMADA (prestamos.cancelacion-rechazada.v1)', true);
  check('Préstamos: sigue su curso', (await loan(prestamo)).estado === 'ENTREGA_REGISTRADA', 'ENTREGA_REGISTRADA');
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

async function incidencias() {
  historia('8. Incidencia con afectación parcial (Evidencias simulada: publica sus eventos según el contrato)');
  const { prestamo } = await activo(Date.now() - HOUR, Date.now() + 23 * HOUR, 20);
  expect('Préstamos: devolución registrada', await call('POST', `/prestamos/${prestamo}/devolucion`, BORROWER), 200);
  const incidencia = randomUUID(), payload = { incidencia_id: incidencia, prestamo_id: prestamo, prestatario_usuario_id: ids[BORROWER], prestamista_usuario_id: ids[LENDER] };
  check('Broker: evidencias.incidencia-reportada.v1 tiene suscriptores', await publish('evidencias.incidencia-reportada.v1', 'IncidenciaReportada', incidencia, payload));
  await until('que Préstamos registre la incidencia', async () => (await loan(prestamo)).estado_detalle === 'PENDIENTE_INCIDENCIA');
  check('Préstamos: queda PENDIENTE_INCIDENCIA', true);
  expect('Préstamos: no se puede cerrar con una incidencia pendiente', await call('POST', `/prestamos/${prestamo}/confirmacion-devolucion`, LENDER), 409);
  await until('que Pagos retenga la garantía', async () => sql('lendup_pagos', `select estado from lendup_pagos.garantias where prestamo_id=uuid_to_bin('${prestamo}')`).out === 'RETENIDA_POR_INCIDENCIA');
  check('Pagos: la garantía queda RETENIDA_POR_INCIDENCIA (RF41)', true);
  await aviso(BORROWER, 'Incidencia reportada', 'el prestatario', (n) => n.origen_id === incidencia);
  check('Broker: evidencias.incidencia-resuelta.v1 tiene suscriptores', await publish('evidencias.incidencia-resuelta.v1', 'IncidenciaResuelta', incidencia, { ...payload, decision_garantia: 'AFECTACION_PARCIAL', monto_garantia_afectado: 20, moneda: 'PEN', justificacion_resolucion: 'Daño leve comprobado.' }));
  const tx = await transaccion(prestamo, 'RETENCION_GARANTIA'), dev = await transaccion(prestamo, 'DEVOLUCION_GARANTIA');
  check('Pagos: retuvo 20 y devolvió 30', tx.monto === 20 && dev.monto === 30, `${tx.monto} / ${dev.monto}`);
  await aviso(LENDER, 'Incidencia resuelta', 'el prestamista', (n) => n.origen_id === incidencia && n.mensaje === 'Daño leve comprobado.');
  await aviso(LENDER, 'Garantía retenida', 'el prestamista');
  await until('que Préstamos libere el cierre', async () => (await loan(prestamo)).estado_detalle === 'DEVOLUCION_REGISTRADA');
  expect('Préstamos: resuelta la incidencia, se puede finalizar', await call('POST', `/prestamos/${prestamo}/confirmacion-devolucion`, LENDER), 200, (b) => b.estado === 'FINALIZADO');
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
  const servicios = ['identidad', 'catalogo', 'reservas', 'prestamos', 'pagos', 'notificaciones', 'reputacion'].map((s) => `lendup_${s}`);
  const tabla = { lendup_identidad: 'usuarios', lendup_catalogo: 'publicaciones', lendup_reservas: 'reservas', lendup_prestamos: 'prestamos', lendup_pagos: 'garantias', lendup_notificaciones: 'notificaciones', lendup_reputacion: 'calificaciones' };
  for (const propio of ['lendup_prestamos', 'lendup_pagos', 'lendup_notificaciones']) {
    const r = sql(propio, `select count(*) from ${propio}.${tabla[propio]}`);
    check(`MySQL: ${propio} lee su propio esquema`, r.ok && Number(r.out) > 0, `${r.out} filas`);
    const ajenos = servicios.filter((s) => s !== propio).map((s) => [s, sql(propio, `select count(*) from ${s}.${tabla[s]}`)]);
    check(`MySQL: ${propio} no puede leer ninguno de los otros ${ajenos.length} esquemas`, ajenos.every(([, x]) => !x.ok && /denied/.test(x.out)), ajenos[0][1].out);
  }
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
  const pendientes = [`POST /prestamos/${x}/evidencias`, `POST /prestamos/${x}/analisis-evidencias`, 'GET /incidencias', 'GET /admin/incidencias'];
  const estados = await Promise.all(pendientes.map(async (r) => (await call(r.split(' ')[0], r.split(' ')[1], BORROWER, r.startsWith('GET') ? undefined : {})).status));
  check('Evidencias: sus rutas siguen en el monolito hasta que exista EVIDENCE_SERVICE_URL', estados.every((s) => s === 418), estados.join(', '));
}

async function outboxes() {
  historia('12. Nada quedó sin entregar');
  const pendientes = {
    lendup_reservas: 'select count(*) from lendup_reservas.outbox_events where published_at is null',
    lendup_prestamos: 'select count(*) from lendup_prestamos.outbox_events where published_at is null',
    lendup_pagos: 'select count(*) from lendup_pagos.outbox_events where published_at is null',
    lendup_reputacion: 'select count(*) from lendup_reputacion.outbox_events where published_at is null',
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
    const otros = await Promise.all(['http://localhost:8085/health', 'http://localhost:8084/health', 'http://localhost:8086/health/ready', 'http://localhost:9099/'].map((u) => fetch(u).then((r) => r.ok).catch(() => false)));
    return [...java, ...otros].every(Boolean);
  }, 180);
  await rabbit('PUT', `/queues/%2F/${SPY}`, { durable: false, arguments: { 'x-max-length': 2000 } });
  await rabbit('POST', `/bindings/%2F/e/lendup.domain.events/q/${SPY}`, { routing_key: '#' });
  await rabbit('DELETE', `/queues/%2F/${SPY}/contents`);
  deadBefore = await deadLetters();
  for (const s of [identidadYCatalogo, solicitudes, cicloCompleto, cancelacion, cancelacionRechazada, cambiosDeFecha, vencimiento, incidencias, resiliencia, independenciaDeDatos, rutasDelFrontend, outboxes]) await s();
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
  const propias = ['prestamos.creado.v1', 'prestamos.objeto-entregado.v1', 'prestamos.activado.v1', 'prestamos.extension-solicitada.v1', 'prestamos.extension-aceptada.v1', 'prestamos.extension-rechazada.v1', 'prestamos.reprogramacion-propuesta.v1', 'prestamos.reprogramacion-rechazada.v1',
    'prestamos.fecha-devolucion-actualizada.v1', 'prestamos.devolucion-registrada.v1', 'prestamos.vencido.v1', 'prestamos.finalizado.v1', 'prestamos.cancelado.v1', 'prestamos.cancelacion-rechazada.v1', 'prestamos.periodo-liberado.v1',
    'pagos.pago-confirmado.v1', 'pagos.pago-rechazado.v1', 'pagos.garantia-constituida.v1', 'pagos.tarifa-liberada.v1', 'pagos.garantia-devuelta.v1', 'pagos.garantia-retenida.v1', 'pagos.reembolso-procesado.v1'];
  const faltan = propias.filter((k) => !seen[k]);
  check(`Los ${Object.values(seen).reduce((s, n) => s + n, 0)} eventos reales cumplen el esquema del productor y lo que exige cada consumidor`, incumplen.length === 0, [...new Set(incumplen)].slice(0, 4).join('; ') || 'sin diferencias');
  const ejemplos = revisarEjemplos();
  check(`Los ${ejemplos.total} ejemplos de los contratos cumplen su esquema`, ejemplos.errors.length === 0, ejemplos.errors.slice(0, 3).join('; ') || 'sin diferencias');
  check(`Préstamos y Pagos publicaron ${propias.length} tipos de evento distintos`, faltan.length === 0, faltan.join(', ') || 'todos');
} catch (e) { failed = e; }

mkdirSync(resolve(root, 'reportes'), { recursive: true });
const ok = results.filter((r) => r.ok).length;
writeFileSync(resolve(root, 'reportes', 'e2e.md'), [`# Prueba de punta a punta de LendUp`, '', `Fecha: ${new Date().toISOString()}  `, `Resultado: **${failed ? 'FALLÓ: ' + failed.message : `${ok}/${results.length} verificaciones en verde`}**`, '',
  'Reales: Identidad, Catálogo, Reservas, Préstamos, Pagos, Notificaciones, Reputación, API Gateway, MySQL y RabbitMQ. Firebase es el emulador oficial y Mercado Pago el modo simulado. Evidencias aún no existe: sus dos eventos se publican a mano.', '',
  ...[...new Set(results.map((r) => r.story))].flatMap((s) => [`## ${s}`, '', '| Verificación | Resultado | Detalle |', '|---|---|---|', ...results.filter((r) => r.story === s).map((r) => `| ${r.name} | ${r.ok ? 'OK' : 'FALLA'} | ${r.detail.replaceAll('|', '/')} |`), '']),
  '## Eventos que pasaron por RabbitMQ', '', '| Routing key | Cantidad |', '|---|---|', ...Object.entries(seen).sort().map(([k, n]) => `| \`${k}\` | ${n} |`), '',
  '## Colas', '', '| Cola | Mensajes pendientes |', '|---|---|', ...queues.map((q) => `| \`${q.name}\` | ${q.messages ?? 0} |`), ''].join('\n'));
console.log(`\n${failed ? 'FALLÓ' : 'TODO EN VERDE'}: ${ok}/${results.length} verificaciones. Reporte: ${resolve(root, 'reportes', 'e2e.md')}`);
process.exit(failed ? 1 : 0);
