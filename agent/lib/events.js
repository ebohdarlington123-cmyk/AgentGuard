// In-memory activity feed for allow / block / pending / approve / reject decisions.
// GET /events returns JSON; GET /events/stream is SSE. Cap keeps RAM bounded.
import { EventEmitter } from 'node:events';
const MAX = 500;
const bus = new EventEmitter();
bus.setMaxListeners(100);
const ring = [];
let seq = 0;

export function recordEvent(partial) {
  const ev = {
    id: ++seq,
    ts: new Date().toISOString(),
    type: partial.type,                 // allow | block | pending | approve | reject | warn
    verdict: partial.verdict ?? partial.type,
    agent: partial.agent ?? null,
    receiver: partial.receiver ?? null,
    amount: partial.amount ?? null,
    risk: partial.risk ?? null,
    reasons: partial.reasons ?? [],
    pending_id: partial.pending_id ?? null,
    memo: partial.memo ?? null,
    meta: partial.meta ?? null,
  };
  ring.push(ev);
  if (ring.length > MAX) ring.shift();
  bus.emit('event', ev);
  return ev;
}

export function listEvents({ since_id = 0, limit = 100, type } = {}) {
  let out = ring.filter((e) => e.id > Number(since_id || 0));
  if (type) out = out.filter((e) => e.type === type);
  return out.slice(-Math.min(500, Math.max(1, Number(limit) || 100)));
}

export function subscribe(fn) {
  bus.on('event', fn);
  return () => bus.off('event', fn);
}

/** Event schema (documented for dashboard consumers):
 * {
 *   id: number,                 // monotonic
 *   ts: string,                 // ISO-8601
 *   type: 'allow'|'block'|'pending'|'approve'|'reject'|'warn',
 *   verdict: string,            // usually same as type
 *   agent: string|null,
 *   receiver: string|null,
 *   amount: string|null,        // yoctoNEAR string when known
 *   risk: number|null,
 *   reasons: string[],
 *   pending_id: string|number|null,
 *   memo: string|null,
 *   meta: object|null
 * }
 */
export const EVENT_SCHEMA_VERSION = 1;
