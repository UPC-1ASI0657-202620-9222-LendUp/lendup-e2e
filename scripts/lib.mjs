// Utilidades comunes: entorno, usuarios (Firebase Auth Emulator + Identidad real), llamadas por el gateway, broker y reporte.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const env = Object.fromEntries(readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
export const GATEWAY = 'http://localhost:8090/api/v1';
export const EMULATOR = 'http://localhost:9099/identitytoolkit.googleapis.com/v1';
const PROJECT = 'lendup-desarrollo';
const RABBIT = 'http://localhost:15680/api';
const rabbitAuth = 'Basic ' + Buffer.from(`lendup:${env.RABBITMQ_PASSWORD}`).toString('base64');
export const SPY = 'debug.lendup.eventos';
export const HOUR = 3600_000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(what, fn, seconds = 30) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) { const last = await fn(); if (last) return last; await sleep(400); }
  throw new Error(`Tiempo agotado esperando: ${what}`);
}
/** Hora de negocio (America/Lima) sin zona, como la usa todo LendUp. */
export const lima = (ms) => new Date(ms - 5 * HOUR).toISOString().slice(0, 19);
export const compose = (...args) => execFileSync('docker', ['compose', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
export function sql(user, query) {
  const password = user === 'lendup_evidencias' ? env.EVIDENCE_DB_PASSWORD : env.DB_PASSWORD;
  try { return { ok: true, out: compose('exec', '-T', '-e', `MYSQL_PWD=${password}`, 'mysql', 'mysql', `-u${user}`, '-N', '-B', '-e', query).trim() }; }
  catch (e) { return { ok: false, out: String(e.stderr ?? e).split('\n').find((l) => l.includes('ERROR')) ?? 'error' }; }
}

// --- usuarios -----------------------------------------------------------------------------------------------------
export const LENDER = 'e2e-prestamista', BORROWER = 'e2e-prestatario', OUTSIDER = 'e2e-intruso', ADMIN = 'e2e-admin-evidencias';
const PEOPLE = {
  [LENDER]: { nombre: 'Prestamista E2E', telefono: '999111222' },
  [BORROWER]: { nombre: 'Prestatario E2E', telefono: '999333444' },
  [OUTSIDER]: { nombre: 'Intruso E2E', telefono: '999555666' },
  [ADMIN]: { nombre: 'Administración Evidencias E2E', telefono: '999555667' },
};
export const emailOf = (uid) => `${uid}@upc.edu.pe`;
const tokens = new Map();
async function firebase(path, body, admin = false) {
  const r = await fetch(`${EMULATOR}${path}${path.includes('?') ? '&' : '?'}key=emulador`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: 'Bearer owner' } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
/** Crea la cuenta en el emulador oficial; verified=false sirve para probar el rechazo de correos sin verificar. */
export async function firebaseAccount(uid, verified = true) {
  await firebase(`/projects/${PROJECT}/accounts`, { localId: uid, email: emailOf(uid), password: env.E2E_USER_PASSWORD, emailVerified: verified }, true);
  const updated = await firebase(`/projects/${PROJECT}/accounts:update`, { localId: uid, password: env.E2E_USER_PASSWORD, emailVerified: verified }, true);
  if (updated.status !== 200) throw new Error(`El emulador no preparó la cuenta de prueba ${uid}: HTTP ${updated.status}`);
  tokens.delete(uid);
}
export async function disableFirebaseAccount(uid, disableUser) {
  const r = await firebase(`/projects/${PROJECT}/accounts:update`, { localId: uid, disableUser }, true);
  if (r.status !== 200) throw new Error(`El emulador no actualizó ${uid}: HTTP ${r.status}`);
}
export async function token(uid) {
  if (!tokens.has(uid)) {
    const r = await firebase('/accounts:signInWithPassword', { email: emailOf(uid), password: env.E2E_USER_PASSWORD, returnSecureToken: true });
    if (!r.body.idToken) throw new Error(`El emulador no entregó token para ${uid}: ${JSON.stringify(r.body)}`);
    tokens.set(uid, r.body.idToken);
  }
  return tokens.get(uid);
}
export const ids = {};
/** Cuenta en Firebase + registro, verificación y términos en Identidad. Se puede repetir. */
export async function ensureUser(uid, base = GATEWAY) {
  const p = PEOPLE[uid];
  await firebaseAccount(uid);
  const alta = await call('POST', '/estudiantes', uid, { correo_institucional: emailOf(uid), nombre: p.nombre, campus: 'Monterrico', carrera: 'Ingeniería de Software', ciclo: 6, telefono: p.telefono }, base);
  if (![201, 409].includes(alta.status)) throw new Error(`Identidad no registró a ${uid}: HTTP ${alta.status} ${JSON.stringify(alta.body)}`);
  const me = await call('GET', '/estudiantes/me', uid, undefined, base);
  const doc = await call('GET', '/documentos/terminos', null, undefined, base);
  await call('POST', '/estudiantes/me/aceptacion-terminos', uid, { version_terminos_aceptada: doc.body.version_terminos, version_descargo_aceptada: doc.body.version_descargo }, base);
  ids[uid] = me.body.usuario.id;
  return { alta, me, doc };
}

// --- llamadas -----------------------------------------------------------------------------------------------------
export async function call(method, path, uid, body, base = GATEWAY) {
  const multipart = body instanceof FormData;
  const response = await fetch(base + path, { method, headers: { ...(uid ? { Authorization: `Bearer ${uid.startsWith('raw:') ? uid.slice(4) : await token(uid)}` } : {}), ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json' }, body: multipart ? body : body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: response.status, body: json, headers: response.headers };
}
export async function rabbit(method, path, body) {
  const r = await fetch(RABBIT + path, { method, headers: { Authorization: rabbitAuth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); return t ? JSON.parse(t) : {};
}
/** Inyección controlada para ejercicios de duplicación y orden de entrega. */
export async function publish(routingKey, eventType, aggregateId, payload) {
  const envelope = { event_id: crypto.randomUUID(), event_type: eventType, event_version: 1, aggregate_version: eventType === 'IncidenciaResuelta' ? 2 : 1, aggregate_id: aggregateId, occurred_at: new Date().toISOString(), correlation_id: aggregateId, payload };
  return publishEnvelope(routingKey, envelope);
}

export async function publishEnvelope(routingKey, envelope) {
  return (await rabbit('POST', '/exchanges/%2F/lendup.domain.events/publish', { routing_key: routingKey, payload: JSON.stringify(envelope), payload_encoding: 'string', properties: { content_type: 'application/json', delivery_mode: 2 } })).routed;
}

// --- reporte ------------------------------------------------------------------------------------------------------
export const results = [];
let story = '';
export function historia(nombre) { story = nombre; console.log('\n' + nombre); }
export function check(name, ok, detail = '') {
  results.push({ story, name, ok: !!ok, detail: String(detail) });
  console.log(`  ${ok ? 'OK   ' : 'FALLA'} ${name}${detail !== '' ? ` -> ${detail}` : ''}`);
  if (!ok) throw new Error(`Falló: ${name} (${detail})`);
}
export const expect = (name, r, status, extra = () => true) =>
  check(name, r.status === status && extra(r.body), `HTTP ${r.status}${r.body?.estado ? ' ' + r.body.estado : ''}${r.body?.message ? ' "' + r.body.message + '"' : ''}${r.body?.error?.code ? ' ' + r.body.error.code : ''}`);
