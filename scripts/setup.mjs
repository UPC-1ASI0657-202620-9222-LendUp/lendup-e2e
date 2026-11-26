// Prepara el entorno local: contraseñas y tokens aleatorios (.env), un esquema y un usuario de MySQL por servicio y una
// cuenta de servicio de Firebase FALSA (clave generada aquí; solo sirve con el emulador).
// Uso: node scripts/setup.mjs   (no sobrescribe lo que ya exista, solo agrega lo que falte)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const generated = resolve(root, '.generated');
const secret = (bytes = 24) => randomBytes(bytes).toString('hex');
mkdirSync(resolve(generated, 'mysql-init'), { recursive: true });

const envFile = resolve(root, '.env');
const current = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
const env = Object.fromEntries(current.split(/\r?\n/).filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const needed = {
  MYSQL_ROOT_PASSWORD: secret(), DB_PASSWORD: secret(), RABBITMQ_PASSWORD: secret(),
  IDENTITY_RESERVATIONS_SERVICE_TOKEN: secret(32), IDENTITY_PAYMENTS_SERVICE_TOKEN: secret(32), IDENTITY_NOTIFICATIONS_SERVICE_TOKEN: secret(32),
  IDENTITY_LOANS_SERVICE_TOKEN: secret(32), IDENTITY_EVIDENCE_SERVICE_TOKEN: secret(32),
  LOANS_EVIDENCE_SERVICE_TOKEN: secret(32), EVIDENCE_LOANS_SERVICE_TOKEN: secret(32), EVIDENCE_DB_PASSWORD: secret(),
  RESERVATIONS_EVIDENCE_SERVICE_TOKEN: secret(32),
  CATALOG_RESERVATIONS_SERVICE_TOKEN: secret(32), LOANS_RESERVATIONS_SERVICE_TOKEN: secret(32), MERCADOPAGO_WEBHOOK_SECRET: secret(32),
  E2E_USER_PASSWORD: secret(12), LENDUP_COMMISSION_PERCENT: '18', SENDGRID_API_KEY: '', SENDGRID_FROM_EMAIL: '',
};
const missing = Object.entries(needed).filter(([k]) => !(k in env));
if (missing.length) {
  writeFileSync(envFile, (current && !current.endsWith('\n') ? current + '\n' : current) + missing.map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  missing.forEach(([k, v]) => { env[k] = v; });
  console.log('.env: agregado', missing.map(([k]) => k).join(', '));
}
// Cada usuario solo puede leer y escribir su propio esquema (R13).
const schemas = ['lendup_identidad', 'lendup_catalogo', 'lendup_reservas', 'lendup_prestamos', 'lendup_pagos', 'lendup_notificaciones', 'lendup_reputacion', 'lendup_evidencias'];
writeFileSync(resolve(generated, 'mysql-init', '01-schemas.sql'), schemas.map((s) =>
  `CREATE DATABASE IF NOT EXISTS ${s} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;\nCREATE USER IF NOT EXISTS '${s}'@'%' IDENTIFIED BY '${s === 'lendup_evidencias' ? env.EVIDENCE_DB_PASSWORD : env.DB_PASSWORD}';\nGRANT ALL PRIVILEGES ON ${s}.* TO '${s}'@'%';`).join('\n') + '\n');

const firebase = resolve(generated, 'firebase-local.json');
if (!existsSync(firebase)) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  writeFileSync(firebase, JSON.stringify({ type: 'service_account', project_id: 'lendup-desarrollo', private_key_id: 'local', private_key: privateKey,
    client_email: 'local@lendup-desarrollo.iam.gserviceaccount.com', client_id: '1', token_uri: 'https://oauth2.googleapis.com/token' }, null, 2));
  console.log('Creada la cuenta de servicio FALSA para el emulador local');
}
console.log('Listo. Ahora: docker compose up -d --build');
