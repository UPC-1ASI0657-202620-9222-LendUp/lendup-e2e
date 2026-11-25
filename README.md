# Pruebas integradas de LendUp (local)

Levanta todo LendUp en un solo RabbitMQ y un solo MySQL (un esquema y un usuario por servicio), construido desde las carpetas vecinas. **No necesita ninguna credencial.**

Clona este repositorio junto a los de los servicios, con sus nombres originales:

```powershell
foreach ($r in "e2e","identity-service","catalog-service","reservations-service","loans-service","payments-service","notifications-service","reputation-service","api-gateway") { git clone "https://github.com/UPC-1ASI0657-202620-9222-LendUp/lendup-$r" }
```

| Real | Simulado |
|---|---|
| Identidad, Catálogo, Reservas, Préstamos, Pagos, Notificaciones, Reputación y API Gateway | Firebase: emulador oficial de Google |
| MySQL, RabbitMQ y Redis | Mercado Pago: `MERCADOPAGO_MODE=simulado` de Pagos |
| | SendGrid: los correos quedan en el log (o se envían si pones `SENDGRID_API_KEY` en `.env`) |
| | Evidencias: aún no existe; sus dos eventos se publican a mano y sus rutas van al "monolito" (`stubs/monolito.mjs`) |

## Preparar (una sola vez)

Con Docker Desktop abierto y Node 20 o superior:

```powershell
cd lendup-e2e
npm ci
node scripts/setup.mjs
node scripts/configurar.mjs
```

`setup.mjs` crea `.env` con contraseñas aleatorias y una cuenta de Firebase falsa. `configurar.mjs` crea el `.env` de Pagos, Notificaciones, Préstamos y el gateway para correr cada uno por separado. Ninguno sobrescribe lo que ya exista.

## Todo junto

```powershell
docker compose up -d --build
node scripts/e2e.mjs
docker compose down
```

`docker compose down -v` borra también los datos. Reporte: `reportes/e2e.md`.

| Servicio | URL |
|---|---|
| API Gateway | http://localhost:8090 |
| Reservas | http://localhost:8081 |
| Pagos | http://localhost:8082/swagger-ui.html |
| Notificaciones | http://localhost:8083/swagger |
| Catálogo | http://localhost:8084/swagger-ui |
| Identidad | http://localhost:8085/docs |
| Reputación | http://localhost:8086/docs |
| Préstamos | http://localhost:8087/swagger-ui.html |
| Emulador de Firebase | http://localhost:9099 |
| RabbitMQ (consola) | http://localhost:15680 (usuario `lendup`, `RABBITMQ_PASSWORD` de `.env`) |
| MySQL | `localhost:3320` |

## Cada microservicio por separado

Con el entorno anterior apagado:

```powershell
node scripts/solo.mjs
```

Levanta cada uno con su propio `docker compose`, comprueba que funciona sin los demás y corre su colección de Postman. Reportes: `reportes/solo.md` y `reportes/postman-*.html`. Para dejar uno encendido:

```powershell
cd ..\lendup-loans-service
docker compose up -d --build
```

## Contratos de eventos

```powershell
node scripts/contratos.mjs
```

Comprueba que los ejemplos cumplen su esquema. `e2e.mjs` hace lo mismo con los eventos reales que pasan por RabbitMQ.

## Con Firebase real

En el `.env` del servicio, borra `FIREBASE_AUTH_EMULATOR_HOST` y reemplaza `.secrets/firebase-service-account.json` por la credencial descargada de la consola de Firebase. Nunca la subas a Git.

Si Notificaciones falla al construir con `NETSDK1064`, es la caché de Docker: `docker compose build --no-cache notifications`.
