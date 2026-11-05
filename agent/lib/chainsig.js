// Chain-signatures / cross-chain destination check (stub). Flags risky foreign-chain recipients in an intent.
// Static rules only for now; plug MPC-derived-address verification in later.
import { solanaAddressRisk, evmAddressRisk } from './modules/crosschain.js';
const BURN = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead', '11111111111111111111111111111111']);
const BLOCKED = new Set((process.env.AGENTGUARD_XCHAIN_BLOCKLIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const HOT = { 56: 'bsc', 137: 'pol', 10: 'op', 43114: 'avax', 534352: 'scroll', 143: 'monad' };
export function chainOf(assetId = '', tokens = null) {
  const t = tokens?.find(x => x.assetId === assetId); if (t) return t.blockchain;
  let m = assetId.match(/^nep141:([a-z]+)(-0x[0-9a-f]+)?\.(omft|omdep)\.near$/); if (m) return m[1];
  m = assetId.match(/^nep245:v2_1\.omni\.hot\.tg:(\d+)_/); if (m) return HOT[m[1]] || 'hot-' + m[1];
  return assetId.startsWith('nep141:') || assetId.startsWith('nep245:') ? 'near' : 'unknown';
}
export function chainSigCheck({ tokens, destinationAsset, recipient = '', recipientType, refundTo, memo = '' } = {}) {
  const reasons = []; let block = false; let weight = 0;
  const chain = chainOf(destinationAsset, tokens); const r = recipient.toLowerCase();
  if (!recipient) return { chain, block: true, weight: 100, reasons: ['intent has no recipient'] };
  if (BURN.has(r)) { block = true; reasons.push(`recipient ${recipient} is a burn/null address`); }
  if (BLOCKED.has(r)) { block = true; reasons.push('recipient on AgentGuard cross-chain blocklist'); }
  const fmt = chain === 'sol' ? solanaAddressRisk(recipient) : ['eth', 'base', 'arb', 'bsc', 'pol', 'op', 'avax', 'gnosis', 'scroll', 'monad', 'abs', 'hood'].includes(chain) ? evmAddressRisk(recipient) : null;
  if (fmt?.invalid) { block = true; reasons.push(`recipient is not a valid ${chain} address`); }
  if (fmt?.reasons?.length) { reasons.push(...fmt.reasons); weight = Math.max(weight, 40); }
  if (chain !== 'near' && /\.near$|\.testnet$/.test(r) && recipientType !== 'INTENTS') { block = true; reasons.push(`NEAR account used as ${chain} recipient (funds would be lost)`); }
  if (refundTo && refundTo !== recipient && !/\.near$|\.testnet$|^0x[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(refundTo)) { reasons.push('refund address looks malformed'); weight = Math.max(weight, 30); }
  if (/(ignore (all|previous) instructions|send (all|everything)|seed phrase|private key)/i.test(memo)) { reasons.push('intent instruction looks like prompt injection'); weight = Math.max(weight, 45); }
  return { chain, block, weight: block ? 100 : weight, reasons };
}
