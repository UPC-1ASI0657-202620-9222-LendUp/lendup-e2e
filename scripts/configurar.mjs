// Deja lista la configuración local de Pagos, Notificaciones, Préstamos y el gateway para correr cada uno por separado:
// crea su .env (contraseñas aleatorias) y una credencial de Firebase FALSA que solo sirve con el emulador.
// No sobrescribe lo que ya exista. Para usar Firebase real: docs en e2e/README.md.   Uso: node scripts/configurar.mjs
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const base = resolve(import.meta.dirname, '..', '..');
const fake = resolve(import.meta.dirname, '..', '.generated', 'firebase-local.json');
const secret = (n = 24) => randomBytes(n).toString('hex');
for (const service of ['lendup-payments-service', 'lendup-notifications-service', 'lendup-loans-service']) {
  const dir = resolve(base, service), env = resolve(dir, '.env');
  if (!existsSync(env)) {
    const values = { DB_PASSWORD: secret(), MYSQL_ROOT_PASSWORD: secret(), RABBITMQ_PASSWORD: secret(), MERCADOPAGO_WEBHOOK_SECRET: secret(32), LOANS_RESERVATIONS_SERVICE_TOKEN: secret(32),
      IDENTITY_SERVICE_BASE_URL: 'http://host.docker.internal:8085', SPRINGDOC_ENABLED: 'true', SWAGGER_ENABLED: 'true', SWAGGER_PUBLIC: 'true' };
    const text = readFileSync(resolve(dir, '.env.example'), 'utf8').replace(/\r\n/g, '\n').split('\n').map((l) => { const k = l.split('=')[0]; return /^[A-Z_]+=/.test(l) && k in values ? `${k}=${values[k]}` : l; }).join('\n');
    writeFileSync(env, text.trimEnd() + '\n# Emulador de Firebase (e2e). Para usar Firebase real: borrar esta línea y poner la credencial en .secrets/\nFIREBASE_AUTH_EMULATOR_HOST=host.docker.internal:9099\n');
    console.log(`${service}: .env creado`);
  }
  const credential = resolve(dir, '.secrets', 'firebase-service-account.json');
  if (!existsSync(credential)) { mkdirSync(resolve(dir, '.secrets'), { recursive: true }); copyFileSync(fake, credential); console.log(`${service}: credencial local del emulador creada`); }
}
const gateway = resolve(base, 'lendup-api-gateway', '.env');
if (!existsSync(gateway)) {
  const text = readFileSync(resolve(base, 'lendup-api-gateway', '.env.example'), 'utf8').replace(/\r\n/g, '\n')
    .replace(/^# ((IDENTITY|CATALOG|REPUTATION|LOANS)_SERVICE_URL=)/gm, '$1').replace('CORS_ORIGINS=http://localhost:5173', 'CORS_ORIGINS=http://localhost:3000,http://localhost:5173');
  writeFileSync(gateway, text);
  console.log('lendup-api-gateway: .env creado');
}
console.log('Configuración local lista');
