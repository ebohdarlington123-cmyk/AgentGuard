import http from 'node:http';
import { score } from './lib/score.js';
import { scoreIntent } from './lib/intents.js';
import { view, GUARD } from './lib/near.js';
import { listPending, getPending, decidePending, enqueuePending } from './lib/pending.js';
import { listEvents, subscribe, EVENT_SCHEMA_VERSION } from './lib/events.js';
import { cacheStats } from './lib/cache.js';
import { recordEvent } from './lib/events.js';

const PORT = process.env.PORT || 8787;
const APPROVE_SECRET = process.env.AG_APPROVE_SECRET || ''; // optional; if set, required on /approve

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, x-ag-approve-secret');
}

http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, 'http://x');
  const send = (c, b) => {
    res.writeHead(c, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(b, null, 2));
  };
  try {
    if (u.pathname === '/health') {
      return send(200, { ok: true, contract: GUARD, features: ['swarm', 'pending', 'events', 'cache'], event_schema: EVENT_SCHEMA_VERSION, cache: cacheStats() });
    }
    if (u.pathname === '/score-intent') {
      const q = Object.fromEntries(u.searchParams); if (q.slippageBps) q.slippageBps = Number(q.slippageBps);
      return send(200, await scoreIntent(q));
    }
    if (u.pathname === '/score') {
      const receiver = u.searchParams.get('receiver'); if (!receiver) return send(400, { error: 'receiver required' });
      const out = await score({
        receiver,
        agent: u.searchParams.get('agent') || undefined,
        amount: u.searchParams.get('amount') || undefined,
        memo: u.searchParams.get('memo') || '',
        record: u.searchParams.get('record') !== '0',
      });
      // Auto-enqueue pending for medium-risk when agent+amount provided and park=1 (default off for pure score reads)
      if (out.verdict === 'pending' && u.searchParams.get('park') === '1') {
        const row = enqueuePending({
          agent: u.searchParams.get('agent'),
          receiver,
          amount: u.searchParams.get('amount'),
          memo: u.searchParams.get('memo') || '',
          score: out,
        });
        out.pending = { id: row.id, status: row.status };
      }
      return send(200, out);
    }
    if (u.pathname === '/agent') return send(200, await view('get_agent', { agent_id: u.searchParams.get('id') }));
    if (u.pathname === '/swarm') return send(200, await view('get_swarm', { swarm_id: u.searchParams.get('id') }));
    if (u.pathname === '/blocklist') return send(200, await view('list_global_blocks', {}));

    // ---- pending approval ----
    if (u.pathname === '/pending' && req.method === 'GET') {
      const status = u.searchParams.get('status') || 'pending';
      const id = u.searchParams.get('id');
      if (id) {
        const row = getPending(id);
        return row ? send(200, row) : send(404, { error: 'not found' });
      }
      return send(200, { pending: listPending({ status: status === 'all' ? '' : status }) });
    }
    if (u.pathname === '/pending' && req.method === 'POST') {
      // manually park a payment
      const body = await readBody(req);
      if (!body.agent || !body.receiver || body.amount == null) return send(400, { error: 'agent, receiver, amount required' });
      const s = body.score || await score({ agent: body.agent, receiver: body.receiver, amount: body.amount, memo: body.memo || '' });
      const row = enqueuePending({ agent: body.agent, receiver: body.receiver, amount: body.amount, memo: body.memo || '', score: s, onchain_pending_id: body.onchain_pending_id ?? null });
      return send(201, row);
    }
    if (u.pathname === '/approve' && req.method === 'POST') {
      if (APPROVE_SECRET) {
        const got = req.headers['x-ag-approve-secret'] || '';
        if (got !== APPROVE_SECRET) return send(401, { error: 'unauthorized' });
      }
      const body = await readBody(req);
      const id = body.id || body.pending_id;
      const action = body.action || body.decision || (body.approve === false ? 'reject' : 'approve');
      if (!id) return send(400, { error: 'id required' });
      const row = await decidePending(id, action, { reason: body.reason || '', useOnchain: body.use_onchain !== false });
      return send(200, row);
    }

    // ---- live activity feed ----
    if (u.pathname === '/events' && req.method === 'GET') {
      const since_id = u.searchParams.get('since_id') || 0;
      const limit = u.searchParams.get('limit') || 100;
      const type = u.searchParams.get('type') || undefined;
      return send(200, { schema_version: EVENT_SCHEMA_VERSION, events: listEvents({ since_id, limit, type }) });
    }
    if (u.pathname === '/events/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ schema_version: EVENT_SCHEMA_VERSION })}\n\n`);
      // replay recent
      for (const ev of listEvents({ limit: 20 })) {
        res.write(`id: ${ev.id}\nevent: decision\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      const unsub = subscribe((ev) => {
        try { res.write(`id: ${ev.id}\nevent: decision\ndata: ${JSON.stringify(ev)}\n\n`); } catch { /* closed */ }
      });
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
      req.on('close', () => { unsub(); clearInterval(ping); });
      return;
    }

    send(404, { error: 'not found' });
  } catch (e) {
    send(e.status || 500, { error: String(e.message || e).slice(0, 300) });
  }
}).listen(PORT, () => console.log(`AgentGuard scoring API on :${PORT} (contract=${GUARD})`));
