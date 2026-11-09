// Vercel serverless proxy to the AgentGuard scoring API (agent/server.js).
// Set AG_API_URL in Vercel env (e.g. https://your-host:8787).
// Routes are allowlisted with methods: everything is GET-only except POST /approve.
// /events/stream is piped through as Server-Sent Events with no buffering.
export const ROUTES = {
  '/health': ['GET'], '/score': ['GET'], '/agent': ['GET'], '/blocklist': ['GET'],
  '/events': ['GET'], '/events/stream': ['GET'], '/pending': ['GET'], '/approve': ['POST'],
};
export const config = { api: { bodyParser: false, responseLimit: false }, supportsResponseStreaming: true, maxDuration: 60 };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 16384) throw new Error('body too large'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
export default async function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  const path = u.searchParams.get('path') || '/health';
  const methods = ROUTES[path];
  if (!methods) return json(res, 400, { error: 'path not allowed' });
  if (!methods.includes(req.method)) { res.setHeader('allow', methods.join(', ')); return json(res, 405, { error: `${req.method} not allowed on ${path}` }); }
  u.searchParams.delete('path');
  const base = (process.env.AG_API_URL || 'http://localhost:8787').replace(/\/$/, '');
  const target = `${base}${path}${u.searchParams.size ? '?' + u.searchParams : ''}`;
  const sse = path === '/events/stream';
  const ctrl = new AbortController(); res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
  try {
    // Cold Render free-tier boots often take 30–50s. The page paints first and shows
    // "Waking up the demo server…"; this wait lets one health/score call finish a boot.
    const init = { method: req.method, signal: sse ? ctrl.signal : AbortSignal.any([ctrl.signal, AbortSignal.timeout(50000)]), headers: {} };
    if (req.method === 'POST') {
      init.body = await readBody(req); init.headers['content-type'] = 'application/json';
      // Optional: if agent/server.js runs with AG_APPROVE_SECRET, set the same env var here (server-side only, never sent to the browser).
      if (path === '/approve' && process.env.AG_APPROVE_SECRET) init.headers['x-ag-approve-secret'] = process.env.AG_APPROVE_SECRET;
    }
    if (sse) init.headers.accept = 'text/event-stream';
    const r = await fetch(target, init);
    if (sse && r.ok && (r.headers.get('content-type') || '').includes('text/event-stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.flushHeaders?.(); res.write(': connected\n\n');
      const reader = r.body.getReader();
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); } } catch {}
      return res.end();
    }
    const text = await r.text();
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
    res.end(text);
  } catch (e) {
    if (ctrl.signal.aborted && sse) return res.end();
    json(res, 502, { error: 'scoring API unreachable: ' + String(e.message || e).slice(0, 200) });
  }
}
