// Ocupa el lugar del monolito (MONOLITH_URL del gateway) y responde 418 a todo. Así la prueba detecta qué rutas NO
// llegan a un microservicio: hoy solo Evidencias e Incidencias y /objetos del Sprint 1.
import { createServer } from 'node:http';
createServer((req, res) => {
  const ok = req.url === '/health';
  res.writeHead(ok ? 200 : 418, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(ok ? { status: 'UP' } : { monolito: true, ruta: req.url }));
}).listen(8080, () => console.log('monolito simulado en 8080'));
