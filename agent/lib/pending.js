// Off-chain pending queue for medium-risk payments. Owner approves/rejects via API;
// on approve we execute on-chain (and optionally resolve an on-chain pending too).
import { randomUUID } from 'node:crypto';
import { recordEvent } from './events.js';

const store = new Map(); // id -> pending

export function listPending({ status = 'pending' } = {}) {
  return [...store.values()].filter((p) => !status || p.status === status);
}

export function getPending(id) {
  return store.get(String(id)) || null;
}

export function enqueuePending({ agent, receiver, amount, memo = '', score, onchain_pending_id = null }) {
  const id = randomUUID();
  const row = {
    id,
    status: 'pending',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    agent,
    receiver,
    amount: amount != null ? String(amount) : null,
    memo,
    risk: score?.risk ?? null,
    reasons: score?.reasons ?? [],
    score,
    onchain_pending_id,
    decision: null,
  };
  store.set(id, row);
  recordEvent({
    type: 'pending',
    verdict: 'pending',
    agent,
    receiver,
    amount: row.amount,
    risk: row.risk,
    reasons: row.reasons,
    pending_id: id,
    memo,
  });
  return row;
}

export async function decidePending(id, action, { reason = '', useOnchain = true } = {}) {
  const row = store.get(String(id));
  if (!row) throw Object.assign(new Error('unknown pending'), { status: 404 });
  if (row.status !== 'pending') throw Object.assign(new Error(`already ${row.status}`), { status: 409 });
  if (action !== 'approve' && action !== 'reject') throw Object.assign(new Error('action must be approve|reject'), { status: 400 });

  // Lazy import to avoid a cycle with guard.js (which enqueues via this module).
  const { rawExecute, approveOnchain, rejectOnchain } = await import('./guard.js');

  if (action === 'reject') {
    let onchain = null;
    if (useOnchain && row.onchain_pending_id != null) {
      onchain = await rejectOnchain({ pendingId: row.onchain_pending_id, reason: reason || 'rejected by owner' });
    }
    row.status = 'rejected';
    row.decision = { action, reason, at: new Date().toISOString(), onchain };
    row.updated_at = row.decision.at;
    recordEvent({
      type: 'reject',
      verdict: 'reject',
      agent: row.agent,
      receiver: row.receiver,
      amount: row.amount,
      risk: row.risk,
      reasons: [reason || 'rejected by owner'],
      pending_id: row.id,
      memo: row.memo,
    });
    return row;
  }

  let onchain = null;
  if (useOnchain && row.onchain_pending_id != null) {
    onchain = await approveOnchain({ pendingId: row.onchain_pending_id });
  } else {
    onchain = await rawExecute({ agent: row.agent, receiver: row.receiver, amount: row.amount, memo: row.memo });
  }
  row.status = onchain?.ok || onchain?.status === 'SENT' ? 'approved' : 'failed';
  row.decision = { action: 'approve', reason, at: new Date().toISOString(), onchain };
  row.updated_at = row.decision.at;
  recordEvent({
    type: 'approve',
    verdict: row.status === 'approved' ? 'approve' : 'block',
    agent: row.agent,
    receiver: row.receiver,
    amount: row.amount,
    risk: row.risk,
    reasons: row.reasons,
    pending_id: row.id,
    memo: row.memo,
    meta: { onchain },
  });
  return row;
}
