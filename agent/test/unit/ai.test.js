import test from 'node:test'; import assert from 'node:assert';
import { aiReview, _reset } from '../../lib/modules/ai.js';
const rule = { verdict: 'block', risk: 100, reasons: ['policy: over cap'] };
const res = (ok, body) => ({ ok, status: ok ? 200 : 402, json: async () => body, text: async () => JSON.stringify(body) });
const mock = (content, ok = true) => async (url) => url.endsWith('/models') ? res(true, { data: [{ id: 'google/gemini-2.5-flash-lite' }] }) : res(ok, ok ? { choices: [{ message: { content } }] } : { error: 'insufficient credits' });
test('no key -> unavailable', async () => { delete process.env.NEARAI_API_KEY; assert.equal((await aiReview({}, rule)).status, 'unavailable'); });
test('valid verdict parsed', async () => {
  process.env.NEARAI_API_KEY = 'test'; delete process.env.NEARAI_MODEL; _reset();
  const v = await aiReview({ receiver: 'x' }, rule, { fetch: mock('```json\n{"risk":"high","reasons":["over cap"],"summary":"block"}\n```') });
  assert.equal(v.status, 'ok'); assert.equal(v.risk, 'high'); assert.equal(v.model, 'google/gemini-2.5-flash-lite'); assert.equal(v.advisory, true);
});
test('bad JSON -> unavailable', async () => { process.env.NEARAI_API_KEY = 'test'; assert.equal((await aiReview({}, rule, { fetch: mock('not json') })).status, 'unavailable'); });
test('bad risk value -> unavailable', async () => { assert.equal((await aiReview({}, rule, { fetch: mock('{"risk":"none"}') })).status, 'unavailable'); });
test('HTTP error surfaced', async () => { const v = await aiReview({}, rule, { fetch: mock('', false) }); assert.equal(v.status, 'unavailable'); assert.match(v.error, /402/); });
test('fetch throws -> unavailable', async () => { assert.equal((await aiReview({}, rule, { fetch: async () => { throw new Error('net'); } })).status, 'unavailable'); });
