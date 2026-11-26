// Comprueba los contratos publicados en cada repo: los ejemplos cumplen su esquema y (desde e2e.mjs) los eventos reales
// que pasaron por RabbitMQ también, tanto contra el esquema del productor como contra lo que exige cada consumidor.
// Uso suelto: node scripts/contratos.mjs
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = resolve(import.meta.dirname, '..', '..');
const read = (repo, file) => JSON.parse(readFileSync(resolve(base, repo, 'contracts/events/v1', file), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addFormat('local-date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/);

const LOANS = 'lendup-loans-service', PAY = 'lendup-payments-service', NOTIF = 'lendup-notifications-service', RES = 'lendup-reservations-service';
const EVIDENCE = 'lendup-evidence-service';
const producer = { prestamos: ajv.compile(read(LOANS, 'loans-events.schema.json')), pagos: ajv.compile(read(PAY, 'payments-events.schema.json')),
  reservas: ajv.compile(read(RES, 'reservations-events.schema.json')), evidencias: ajv.compile(read(EVIDENCE, 'evidence-events.schema.json')) };
const payConsumed = ajv.compile(read(PAY, 'consumed-events.schema.json'));
const notifDefs = read(NOTIF, 'consumed-events.schema.json').$defs;
const notif = Object.fromEntries(Object.entries(notifDefs).map(([k, v]) => [k, ajv.compile({ ...v, $id: undefined })]));
const notifFor = (key) => {
  if (key === 'reservas.solicitud-creada.v1') return notif.solicitudCreada;
  if (/^reservas\.solicitud-(rechazada|cancelada)/.test(key)) return notif.solicitudCerrada;
  if (key === 'reservas.confirmada.v1') return notif.reservaConfirmada;
  if (key === 'reservas.cancelada.v1') return notif.reservaCancelada;
  if (key.startsWith('pagos.')) return notif.pagos;
  if (/^prestamos\.(extension-(solicitada|aceptada|rechazada)|reprogramacion|fecha-devolucion)/.test(key)) return notif.cambioDeFecha;
  if (/^prestamos\.(objeto-entregado|activado|devolucion-registrada|vencido|finalizado|cancelacion-rechazada|recuperacion-pendiente)/.test(key)) return notif.prestamo;
  if (key.startsWith('evidencias.incidencia-')) return notif.incidencia;
  if (key.startsWith('reputation.')) return notif.calificacionRegistrada;
  return null;
};
const PAY_KEYS = /^(reservas\.(confirmada|cancelada|extension-retencion-rechazada)|prestamos\.(creado|activado|devolucion-registrada|finalizado|extension-aceptada|fecha-devolucion-actualizada)|evidencias\.incidencia-)/;

/** Devuelve la lista de incumplimientos de un mensaje. */
export function revisar(key, message) {
  const errors = [];
  const run = (who, validate, data) => { if (validate && !validate(data)) errors.push(`${key} (${who}): ${ajv.errorsText(validate.errors).slice(0, 160)}`); };
  run('esquema del productor', producer[key.split('.')[0]], message);
  run('Notificaciones', notifFor(key), message.payload ?? message);
  if (PAY_KEYS.test(key)) run('Pagos', payConsumed, message);
  return errors;
}

export function revisarEjemplos() {
  const errors = []; let total = 0;
  const each = (entries, fn) => Object.entries(entries).forEach(([k, v]) => { total++; fn(k.replace(' (pendiente)', ''), v); });
  each(read(LOANS, 'examples.json').emitted, (k, v) => errors.push(...revisar(k, v)));
  each(read(EVIDENCE, 'examples.json'), (k, v) => errors.push(...revisar(k, v)));
  each(read(PAY, 'examples.json').emitted, (k, v) => errors.push(...revisar(k, v)));
  each(read(PAY, 'examples.json').consumed, (k, v) => { if (!payConsumed(v)) errors.push(`${k} (ejemplo de Pagos): ${ajv.errorsText(payConsumed.errors).slice(0, 160)}`); });
  each(read(NOTIF, 'examples.json'), (k, v) => { const validate = notifFor(k); if (!validate) errors.push(`${k}: sin definición en Notificaciones`); else if (!validate(v.payload ?? v)) errors.push(`${k} (ejemplo de Notificaciones): ${ajv.errorsText(validate.errors).slice(0, 160)}`); });
  return { total, errors };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { total, errors } = revisarEjemplos();
  console.log(errors.length ? errors.join('\n') : `${total} ejemplos cumplen su esquema`);
  process.exit(errors.length ? 1 : 0);
}
