// Agent-side wrapper: the ONLY way the agent spends. Refuses on block, parks
// medium-risk as pending for the owner, and signs with a function-call key
// scoped to GUARD.execute_transfer / request_transfer (contract re-checks).
import { account, GUARD, ROOT } from './near.js';
import { score } from './score.js';
import { enqueuePending } from './pending.js';
import { recordEvent } from './events.js';

export async function guardedPay({
  agent,
  receiver,
  amount,
  memo = '',
  askHuman = null, // legacy; if provided and returns true, treat as approve
  parkPending = true,
  log = console.log,
}) {
  const s = await score({ agent, receiver, amount, memo });
  log(`[AgentGuard] ${s.verdict.toUpperCase()} risk=${s.risk} ${receiver} :: ${s.reasons.join('; ') || 'no issues'}`);

  if (s.verdict === 'block') {
    recordEvent({ type: 'block', verdict: 'block', agent, receiver, amount, risk: s.risk, reasons: s.reasons, memo });
    return { sent: false, stage: 'wrapper', score: s };
  }

  if (s.verdict === 'allow') {
    const res = await rawExecute({ agent, receiver, amount, memo });
    recordEvent({
      type: res.ok || res.status === 'SENT' ? 'allow' : 'block',
      verdict: res.status || 'allow',
      agent, receiver, amount, risk: s.risk, reasons: s.reasons, memo,
      meta: { onchain: res },
    });
    return { sent: !!res.ok || res.status === 'SENT', stage: 'contract', onchain: res, score: s };
  }

  // pending / warn (medium risk)
  if (askHuman) {
    const ok = await askHuman(s);
    if (!ok) {
      recordEvent({ type: 'reject', verdict: 'reject', agent, receiver, amount, risk: s.risk, reasons: s.reasons, memo });
      return { sent: false, stage: 'human-declined', score: s };
    }
    const res = await rawExecute({ agent, receiver, amount, memo });
    recordEvent({ type: 'approve', verdict: 'approve', agent, receiver, amount, risk: s.risk, reasons: s.reasons, memo, meta: { onchain: res } });
    return { sent: !!res.ok || res.status === 'SENT', stage: 'contract', onchain: res, score: s };
  }

  if (!parkPending) {
    recordEvent({ type: 'pending', verdict: 'pending', agent, receiver, amount, risk: s.risk, reasons: s.reasons, memo });
    return { sent: false, stage: 'pending', score: s };
  }

  // Prefer on-chain pending so the owner can approve_pending with their key.
  let onchainPendingId = null;
  try {
    const req = await requestOnchain({ agent, receiver, amount, memo, reason: s.reasons.join('; ') || 'medium risk' });
    if (req.status === 'PENDING') onchainPendingId = req.pending_id;
    else if (req.status === 'BLOCKED') {
      recordEvent({ type: 'block', verdict: 'block', agent, receiver, amount, risk: s.risk, reasons: [req.reason, ...s.reasons], memo });
      return { sent: false, stage: 'contract', onchain: req, score: { ...s, verdict: 'block' } };
    }
  } catch (e) {
    // fall through to off-chain-only pending
    log(`[AgentGuard] on-chain request_transfer failed, using off-chain pending: ${String(e.message || e).slice(0, 120)}`);
  }

  const row = enqueuePending({ agent, receiver, amount, memo, score: s, onchain_pending_id: onchainPendingId });
  return { sent: false, stage: 'pending', pending: row, score: s };
}

export async function rawExecute({ agent, receiver, amount, memo }) {
  const a = await account(agent);
  const out = await a.functionCall({
    contractId: GUARD,
    methodName: 'execute_transfer',
    args: { receiver_id: receiver, amount, memo },
    gas: 100000000000000n,
  });
  const v = out.status?.SuccessValue;
  const parsed = v ? JSON.parse(Buffer.from(v, 'base64').toString()) : null;
  return { ...parsed, tx: out.transaction.hash };
}

export async function requestOnchain({ agent, receiver, amount, memo, reason }) {
  const a = await account(agent);
  const out = await a.functionCall({
    contractId: GUARD,
    methodName: 'request_transfer',
    args: { receiver_id: receiver, amount, memo, reason },
    gas: 50000000000000n,
  });
  const v = out.status?.SuccessValue;
  const parsed = v ? JSON.parse(Buffer.from(v, 'base64').toString()) : null;
  return { ...parsed, tx: out.transaction.hash };
}

export async function approveOnchain({ pendingId, owner = ROOT }) {
  const a = await account(owner);
  const out = await a.functionCall({
    contractId: GUARD,
    methodName: 'approve_pending',
    args: { pending_id: Number(pendingId) },
    gas: 100000000000000n,
  });
  const v = out.status?.SuccessValue;
  const parsed = v ? JSON.parse(Buffer.from(v, 'base64').toString()) : null;
  return { ...parsed, tx: out.transaction.hash };
}

export async function rejectOnchain({ pendingId, reason = 'rejected by owner', owner = ROOT }) {
  const a = await account(owner);
  const out = await a.functionCall({
    contractId: GUARD,
    methodName: 'reject_pending',
    args: { pending_id: Number(pendingId), reason },
    gas: 50000000000000n,
  });
  const v = out.status?.SuccessValue;
  const parsed = v ? JSON.parse(Buffer.from(v, 'base64').toString()) : null;
  return { ...parsed, tx: out.transaction.hash };
}
