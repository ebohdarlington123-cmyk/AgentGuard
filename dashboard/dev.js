// Local dev server: serves public/ and mounts api/proxy.js at /api/proxy (mimics Vercel).
// Same route/method allowlist as Vercel (enforced inside api/proxy.js); SSE is streamed unbuffered.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import handler from './api/proxy.js';
const PORT = process.env.PORT || 3000; const pub = new URL('./public/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/proxy')) return handler(req, res); // body is left unparsed, as with bodyParser:false
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const f = path.join(pub, req.url === '/' ? 'index.html' : path.normalize(req.url.split('?')[0]));
  if (!f.startsWith(pub) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
}).listen(PORT, () => console.log(`dashboard on http://localhost:${PORT}`));
