import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.FRONTEND_PORT || 5173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const relative = normalize(pathname === '/' ? 'index.html' : pathname.slice(1));
  const path = join(root, relative);
  if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    createReadStream(path).pipe(res);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, () => console.log(`BH Verde frontend at http://localhost:${port}`));
