// NEAR Intents (1Click) DRY quote helpers. Never executes: always sends dry:true, never deposits/signs.
// Intents has no testnet, so this hits the mainnet 1Click API read-only. Optional JWT via ONECLICK_JWT env (never logged).
import { chainSigCheck } from './chainsig.js';
const API = process.env.ONECLICK_API || 'https://1click.chaindefuser.com';
let tokenCache = null;
export async function listTokens() {
  if (tokenCache) return tokenCache;
  const r = await fetch(`${API}/v0/tokens`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`tokens ${r.status}`); return (tokenCache = await r.json());
}
export function buildDryQuoteRequest({ originAsset, destinationAsset, amount, recipient, refundTo, recipientType = 'DESTINATION_CHAIN', slippageBps = 100, deadlineMin = 30 }) {
  return { dry: true, swapType: 'EXACT_INPUT', slippageTolerance: slippageBps, originAsset, depositType: 'ORIGIN_CHAIN',
    destinationAsset, amount: String(amount), refundTo: refundTo || recipient, refundType: 'ORIGIN_CHAIN', recipient, recipientType,
    deadline: new Date(Date.now() + deadlineMin * 60000).toISOString(), referral: 'agentguard' };
}
// Returns { source: 'oneclick'|'estimate', quote, error? }. Falls back to a /v0/tokens price estimate if the quote API refuses.
export async function dryQuote(intent) {
  const body = buildDryQuoteRequest(intent);
  if (body.dry !== true) throw new Error('refusing non-dry quote');
  const headers = { 'content-type': 'application/json' };
  if (process.env.ONECLICK_JWT) headers.authorization = `Bearer ${process.env.ONECLICK_JWT}`;
  let error;
  try {
    const r = await fetch(`${API}/v0/quote`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.quote) return { source: 'oneclick', quote: j.quote, request: body };
    error = `quote API ${r.status}: ${j.message || 'no quote'}`;
  } catch (e) { error = `quote API unreachable: ${e.message}`; }
  try { return { source: 'estimate', quote: await estimate(intent), request: body, error }; }
  catch (e) { return { source: 'none', quote: null, request: body, error: `${error}; ${e.message}` }; }
}
export async function estimate({ originAsset, destinationAsset, amount }) {
  const t = await listTokens(); const a = t.find(x => x.assetId === originAsset), b = t.find(x => x.assetId === destinationAsset);
  if (!a || !b) throw new Error(`unknown asset ${!a ? originAsset : destinationAsset}`);
  const inUsd = Number(amount) / 10 ** a.decimals * a.price;
  return { amountInUsd: inUsd.toFixed(2), amountOutFormatted: (inUsd / b.price).toFixed(6), amountOutUsd: inUsd.toFixed(2), estimated: true };
}
// Risk-score an intent without executing it.
export async function scoreIntent(intent, { quoteFn = dryQuote, maxSlippageBps = 300, maxValueUsd = 1000 } = {}) {
  const reasons = []; let risk = 0;
  const warn = (r, w) => { reasons.push(r); risk = Math.max(risk, Math.min(99, risk + w)); };
  const block = (r) => { reasons.push(r); risk = 100; };
  if ((intent.slippageBps ?? 100) > maxSlippageBps) warn(`slippage ${(intent.slippageBps / 100).toFixed(1)}% is above ${maxSlippageBps / 100}%`, 40);
  const cs = chainSigCheck(intent);
  for (const r of cs.reasons) cs.block ? block(r) : warn(r, cs.weight);
  const q = await quoteFn(intent);
  if (!q.quote) warn(`no quote available (${q.error})`, 30);
  else {
    const inUsd = Number(q.quote.amountInUsd), outUsd = Number(q.quote.amountOutUsd);
    if (inUsd > maxValueUsd) warn(`intent value $${inUsd.toFixed(0)} exceeds $${maxValueUsd} review limit`, 40);
    if (inUsd > 0 && outUsd / inUsd < 0.95) warn(`quote loses ${((1 - outUsd / inUsd) * 100).toFixed(1)}% of value`, 45);
  }
  const verdict = risk >= 100 ? 'block' : risk >= 40 ? 'warn' : 'allow';
  return { verdict, risk, reasons, quote: q, chain_sig: cs, executed: false };
}
