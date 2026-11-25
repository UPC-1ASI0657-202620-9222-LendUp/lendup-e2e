// Prueba que cada microservicio propio funciona POR SEPARADO, con su propio docker compose (su MySQL y su RabbitMQ):
//   A. Sin nada más encendido: arranca, está sano, protege su API y procesa eventos en su propia base.
//   B. Con Firebase (emulador) e Identidad: corre su colección de Postman completa con newman.
// Necesita el entorno e2e apagado (usa los mismos puertos).   Uso: node scripts/solo.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import newman from 'newman';
import { BORROWER, LENDER, OUTSIDER, check, compose, ensureUser, expect, historia, ids, results, root, sleep, token, until } from './lib.mjs';

const base = resolve(root, '..');
const envOf = (dir) => Object.fromEntries(readFileSync(resolve(base, dir, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const run = (dir, project, ...args) => execFileSync('docker', ['compose', '-p', project, ...args], { cwd: resolve(base, dir), stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const get = async (url, bearer) => { const r = await fetch(url, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} }); const t = await r.text(); let body; try { body = JSON.parse(t); } catch { body = { raw: t.slice(0, 120) }; } return { status: r.status, body }; };

const SERVICES = [
  { nombre: 'Préstamos', dir: 'lendup-loans-service', project: 'lendup-solo-loans', port: 8087, rabbit: 15677, schema: 'lendup_prestamos', api: '/api/v1/prestamos', swagger: '/v3/api-docs',
    collection: 'docs/postman/lendup-loans.postman_collection.json',
    tabla: (r) => `select count(*) from prestamos where reserva_id=uuid_to_bin('${r}') and estado='RESERVADO'`,
    extra: async (s, sql) => {
      const o = await until('que el outbox intente publicar', async () => { const x = sql("select concat(attempts,'|',last_error) from outbox_events where published_at is null limit 1"); return x.includes('Ninguna cola') && x; }, 30);
      check('Préstamos solo: PrestamoCreado espera a que exista un consumidor, sin perderse', true, o);
    } },
  { nombre: 'Pagos', dir: 'lendup-payments-service', project: 'lendup-solo-payments', port: 8082, rabbit: 15675, schema: 'lendup_pagos', api: '/api/v1/medios-pago', swagger: '/v3/api-docs',
    collection: 'docs/postman/lendup-payments.postman_collection.json',
    tabla: (r) => `select count(*) from prestamos_pagables where reserva_id=uuid_to_bin('${r}') and estado='RESERVADO'`,
    orden: ['Readiness', 'Mi usuario en Identidad', 'Crear cola espía', 'Enlazar cola espía', 'ReservaConfirmada', 'PrestamoCreado', 'Listar medios', 'Desglose del costo', 'Constituir garantía', 'Aprobar pago', 'Constituir garantía repetida', 'Pagar tarifa (60.00', 'Pagar tarifa con la misma clave', 'Pagar tarifa con monto incorrecto',
      'Abrir checkout simulado', 'Aprobar pago', 'PrestamoActivado', 'ExtensionAceptada', 'Pagar extensión', 'Aprobar pago', 'DevolucionRegistrada', 'IncidenciaReportada', 'IncidenciaResuelta', 'PrestamoFinalizado', 'Consultar transacciones', 'Sin token', 'Webhook con firma inválida', 'Ver eventos en la cola espía'] },
  { nombre: 'Notificaciones', dir: 'lendup-notifications-service', project: 'lendup-solo-notifications', port: 8083, rabbit: 15676, schema: 'lendup_notificaciones', api: '/api/v1/notificaciones', swagger: '/swagger/v1/swagger.json',
    collection: 'docs/postman/lendup-notifications.postman_collection.json',
    tabla: (r) => `select count(*) from notificaciones where origen_id='${r}' and tipo='RECORDATORIO'`,
    orden: ['Liveness', 'Readiness', 'Mi usuario en Identidad', 'SolicitudCreada', 'SolicitudRechazada', 'ReservaConfirmada', 'PagoConfirmado', 'GarantiaDevuelta', 'PrestamoActivado', 'ObjetoEntregado', 'ExtensionSolicitada', 'FechaDevolucionActualizada', 'PrestamoVencido', 'DevolucionRegistrada',
      'CalificacionRegistrada', 'ReembolsoRechazado', 'IncidenciaResuelta', 'ReservaCancelada', 'Listar mis', 'Marcar como', 'Marcar otra vez', 'Notificación inexistente', 'Sin token'] },
];

async function solo(s) {
  historia(`${s.nombre} corriendo solo`);
  const env = envOf(s.dir);
  run(s.dir, s.project, 'up', '-d', '--build', '--wait', '--wait-timeout', '240');
  const salud = await get(`http://localhost:${s.port}/actuator/health/readiness`);
  expect(`${s.nombre}: arranca sano con su propio MySQL y RabbitMQ`, salud, 200, (b) => b.status === 'UP');
  expect(`${s.nombre}: sin token responde 401`, await get(`http://localhost:${s.port}${s.api}`), 401);
  const docs = await get(`http://localhost:${s.port}${s.swagger}`);
  check(`${s.nombre}: publica su OpenAPI (RNF16)`, docs.status === 200 && Object.keys(docs.body.paths ?? {}).length > 0, `${Object.keys(docs.body.paths ?? {}).length} rutas`);
  const servicios = run(s.dir, s.project, 'ps', '--format', '{{.Service}}').trim().split('\n').map((x) => x.trim()).sort().join(', ');
  check(`${s.nombre}: no necesita ningún otro servicio de LendUp`, servicios.split(', ').length === 3, servicios);
  const reserva = randomUUID();
  const envelope = { event_id: randomUUID(), event_type: 'ReservaConfirmada', event_version: 1, aggregate_version: 1, aggregate_id: reserva, occurred_at: new Date().toISOString(), correlation_id: 'solo',
    payload: { reserva_id: reserva, solicitud_id: randomUUID(), publicacion_id: randomUUID(), prestamista_usuario_id: randomUUID(), prestatario_usuario_id: randomUUID(), desde: '2027-01-10T09:00:00', hasta: '2027-01-12T09:00:00', tarifa_diaria_acordada: 20, garantia_monetaria_acordada: 50, moneda_acordada: 'PEN' } };
  const r = await fetch(`http://localhost:${s.rabbit}/api/exchanges/%2F/lendup.domain.events/publish`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${env.RABBITMQ_USERNAME}:${env.RABBITMQ_PASSWORD}`).toString('base64'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ routing_key: 'reservas.confirmada.v1', payload: JSON.stringify(envelope), payload_encoding: 'string', properties: { content_type: 'application/json' } }) }).then((x) => x.json());
  check(`${s.nombre}: su cola recibe eventos de otros servicios`, r.routed === true);
  const sql = (q) => run(s.dir, s.project, 'exec', '-T', '-e', `MYSQL_PWD=${env.DB_PASSWORD}`, 'mysql', 'mysql', `-u${env.DB_USERNAME}`, '-N', '-B', s.schema, '-e', q).trim();
  const filas = await until('que procese el evento', async () => { const n = Number(sql(s.tabla(reserva))); return n > 0 && n; });
  check(`${s.nombre}: procesa el evento y lo guarda en su base`, true, `${filas} filas`);
  if (s.extra) await s.extra(s, sql);
}

async function postman(s) {
  historia(`${s.nombre}: Postman (con Firebase e Identidad)`);
  const env = envOf(s.dir);
  const collection = JSON.parse(readFileSync(resolve(base, s.dir, s.collection), 'utf8'));
  if (s.orden) { // el orden de la colección es para uso manual: aquí se arma el recorrido completo
    const todos = []; const walk = (items) => items.forEach((i) => (i.item ? walk(i.item) : todos.push(i))); walk(collection.item);
    collection.item = s.orden.map((n) => { const i = todos.find((x) => x.name.startsWith(n)); if (!i) throw new Error(`La colección no tiene "${n}"`); return structuredClone(i); });
  }
  const values = { modo_emulador: 'si', identity_url: 'http://localhost:8085', rabbit_url: `http://localhost:${s.rabbit}`, rabbit_user: env.RABBITMQ_USERNAME, rabbit_pass: env.RABBITMQ_PASSWORD, firebase_token: await token(BORROWER),
    token_prestamista: await token(LENDER), token_prestatario: await token(BORROWER), token_intruso: await token(OUTSIDER),
    prestatario_usuario_id: ids[BORROWER], prestamista_usuario_id: ids[LENDER] };
  if (s.orden) Object.assign(values, { reserva_id: randomUUID(), prestamo_id: randomUUID(), cambio_fecha_prestamo_id: randomUUID(), incidencia_id: randomUUID() });
  mkdirSync(resolve(root, 'reportes'), { recursive: true });
  const archivo = resolve(root, 'reportes', `postman-${s.dir.split('-')[1]}.html`);
  const summary = await new Promise((ok, ko) => newman.run({ collection, environment: { values: Object.entries(values).map(([key, value]) => ({ key, value, enabled: true })) }, delayRequest: s.orden ? 900 : 0, reporters: ['htmlextra'],
    reporter: { htmlextra: { export: archivo, title: `LendUp - ${s.nombre}`, browserTitle: `Reporte ${s.nombre}`, skipHeaders: ['Authorization'], omitHeaders: true } } }, (e, r) => (e ? ko(e) : ok(r))));
  const { assertions } = summary.run.stats;
  check(`${s.nombre}: colección de Postman`, summary.run.failures.length === 0, `${assertions.total - assertions.failed}/${assertions.total} verificaciones` + summary.run.failures.map((f) => `; ${f.source?.name}: ${f.error.message}`).join(''));
}

let failed = null;
try {
  for (const s of SERVICES) await solo(s);
  historia('Fase B: se encienden solo Firebase (emulador) e Identidad');
  compose('up', '-d', '--wait', 'firebase', 'identity');
  const identidad = 'http://localhost:8085/api/v1';
  for (const uid of [LENDER, BORROWER, OUTSIDER]) await ensureUser(uid, identidad);
  check('Firebase e Identidad listos', !!ids[BORROWER]);
  for (const s of SERVICES) {
    await until(`que ${s.nombre} acepte el token`, async () => (await get(`http://localhost:${s.port}${s.api}`, await token(BORROWER))).status === 200, 60);
    check(`${s.nombre}: con Firebase e Identidad responde 200 al estudiante`, true);
    await postman(s);
  }
} catch (e) { failed = e; console.error('\n' + e.message + (e.stderr ? '\n' + String(e.stderr).slice(-600) : '')); }
for (const s of SERVICES) try { run(s.dir, s.project, 'down', '-v'); } catch { /* ya estaba apagado */ }
try { compose('stop'); } catch { /* ya estaba apagado */ }
const ok = results.filter((r) => r.ok).length;
writeFileSync(resolve(root, 'reportes', 'solo.md'), ['# Cada microservicio por separado', '', `Fecha: ${new Date().toISOString()}  `, `Resultado: **${failed ? 'FALLÓ: ' + failed.message : `${ok}/${results.length} verificaciones en verde`}**`, '',
  ...[...new Set(results.map((r) => r.story))].flatMap((h) => [`## ${h}`, '', '| Verificación | Resultado | Detalle |', '|---|---|---|', ...results.filter((r) => r.story === h).map((r) => `| ${r.name} | ${r.ok ? 'OK' : 'FALLA'} | ${r.detail.replaceAll('|', '/')} |`), ''])].join('\n'));
console.log(`\n${failed ? 'FALLÓ' : 'TODO EN VERDE'}: ${ok}/${results.length}. Reportes en ${resolve(root, 'reportes')}`);
process.exit(failed ? 1 : 0);
