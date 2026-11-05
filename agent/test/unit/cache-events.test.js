import { test } from 'node:test'; import assert from 'node:assert/strict';
import { cached, cacheClear, cacheStats } from '../../lib/cache.js';
import { recordEvent, listEvents, subscribe, EVENT_SCHEMA_VERSION } from '../../lib/events.js';
import { enqueuePending, listPending, decidePending } from '../../lib/pending.js';

test('cache hits within TTL', async () => {
  cacheClear();
  let n = 0;
  const v1 = await cached('k', 1000, async () => { n++; return 42; });
  const v2 = await cached('k', 1000, async () => { n++; return 99; });
  assert.equal(v1, 42); assert.equal(v2, 42); assert.equal(n, 1);
  assert.ok(cacheStats().size >= 1);
});

test('events ring + subscribe', async () => {
  const seen = [];
  const unsub = subscribe((e) => seen.push(e));
  const ev = recordEvent({ type: 'allow', agent: 'a', receiver: 'b', risk: 0, reasons: [] });
  assert.equal(ev.id > 0, true);
  assert.equal(EVENT_SCHEMA_VERSION, 1);
  assert.ok(listEvents({ since_id: ev.id - 1 }).some((x) => x.id === ev.id));
  assert.equal(seen.at(-1).id, ev.id);
  unsub();
});

test('pending enqueue + reject without onchain', async () => {
  const row = enqueuePending({ agent: 'a.near', receiver: 'b.near', amount: '1', score: { risk: 50, reasons: ['x'] } });
  assert.equal(listPending().some((p) => p.id === row.id), true);
  const d = await decidePending(row.id, 'reject', { useOnchain: false, reason: 'no' });
  assert.equal(d.status, 'rejected');
});
