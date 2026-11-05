// AgentGuard risk scoring: allow | pending | block, with reasons. Read-only (RPC views only).
import { near, view, GUARD, NETWORK } from './near.js';
import { scoreIntent } from './intents.js';
import { aiReview } from './modules/ai.js';
import { evmCalldataRisk, solanaIxRisk } from './modules/crosschain.js';
import { cached } from './cache.js';
import { recordEvent } from './events.js';

const INJECTION = /(ignore (all|previous|prior) (instructions|rules)|system override|urgent(ly)? send|send (all|everything)|drain|seed phrase|private key|airdrop claim|verify (your )?wallet)/i;
const KNOWN_GOOD = new Set(['wrap.testnet', 'usdc.fakes.testnet', 'v2.ref-finance.testnet']);
const VIEW_TTL = Number(process.env.AG_CACHE_TTL_MS || 30000);
const AGE_TTL = Number(process.env.AG_AGE_CACHE_TTL_MS || 120000);

async function rpc(method, params) {
  const n = await near();
  return n.connection.provider.sendJsonRpc(method, params);
}
async function accountInfo(id) {
  return cached(`acct:${id}`, VIEW_TTL, async () => {
    try { return await rpc('query', { request_type: 'view_account', finality: 'final', account_id: id }); }
    catch { return null; }
  });
}
async function nearblocksAge(id) {
  if (NETWORK !== 'testnet' && NETWORK !== 'mainnet') return null;
  return cached(`age:${id}`, AGE_TTL, async () => {
    const base = NETWORK === 'testnet' ? 'https://api-testnet.nearblocks.io' : 'https://api.nearblocks.io';
    try {
      const r = await fetch(`${base}/v1/account/${id}`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return null;
      const j = await r.json();
      const a = j.account?.[0];
      const ns = a?.created?.block_timestamp;
      return ns ? (Date.now() - Number(BigInt(ns) / 1000000n)) / 86400000 : null;
    } catch { return null; }
  });
}
function lookalike(id) {
  const brands = ['near', 'wrap', 'usdc', 'usdt', 'ref-finance', 'aurora', 'binance', 'bitget'];
  const base = id.split('.')[0].toLowerCase();
  return brands.find(b => base !== b && base.replace(/[0o]/g, 'o').replace(/[1l]/g, 'l').includes(b) && /(claim|support|airdrop|verify|official|help|refund)/.test(base)) || null;
}

async function cachedView(method, args) {
  const key = `view:${method}:${JSON.stringify(args)}`;
  return cached(key, VIEW_TTL, () => view(method, args));
}

export async function score({ agent, receiver, amount, memo = '', intent, evmCalldata, solanaIxs, record = false }) {
  const reasons = []; let risk = 0; const signals = {};
  const block = (r) => { reasons.push(r); risk = 100; };
  const warn = (r, w) => { reasons.push(r); risk = Math.max(risk, Math.min(99, risk + w)); };
  // Fetch independent signals in parallel (cache keeps warm path cheap)
  const [rs, pc, info, age] = await Promise.all([
    cachedView('receiver_status', { account_id: receiver }),
    (agent && amount)
      ? cachedView('check_transfer', { agent_id: agent, receiver_id: receiver, amount })
      : Promise.resolve(null),
    accountInfo(receiver),
    nearblocksAge(receiver),
  ]);
  // 1. on-chain shared blocklist + reports (cached)
  signals.receiver_status = rs;
  if (rs.globally_blocked) block(`on shared AgentGuard blocklist (${rs.block_reason})`);
  else if (rs.report_count > 0) warn(`${rs.report_count} community scam report(s)`, 40);
  // 2. on-chain policy dry-run (caps, allowlist, pause)
  if (pc) { signals.policy = pc; if (!pc.ok) block(`policy: ${pc.reason}`); }
  // 3. account existence / contract / age
  signals.exists = !!info;
  if (!info && !/^[0-9a-f]{64}$/.test(receiver)) warn('receiver account does not exist (funds would bounce)', 50);
  if (info) {
    signals.is_contract = info.code_hash !== '11111111111111111111111111111111';
    if (signals.is_contract && !KNOWN_GOOD.has(receiver)) warn('receiver is an unverified contract', 20);
  }
  signals.age_days = age;
  if (age !== null && age < 2 && !KNOWN_GOOD.has(receiver)) warn(`receiver account is new (${age.toFixed(1)} days old)`, 25);
  // 4. content heuristics
  if (INJECTION.test(memo)) warn('payment instruction looks like prompt injection', 45);
  const la = lookalike(receiver); if (la) warn(`name impersonates "${la}"`, 45);
  // 5. optional NEAR Intents
  if (intent) {
    const si = await scoreIntent({ memo, ...intent }); signals.intent = si;
    for (const r of si.reasons) si.verdict === 'block' && si.risk >= 100 ? block(`intent: ${r}`) : warn(`intent: ${r}`, 40);
  }
  // 6. optional ChainMedic-ported checks
  for (const r of [...(evmCalldata ? evmCalldataRisk(evmCalldata) : []), ...(solanaIxs ? solanaIxRisk(solanaIxs) : [])]) warn(r, 50);
  // medium-risk => pending (was "warn"); high => block; else allow
  const verdict = risk >= 100 ? 'block' : risk >= 40 ? 'pending' : 'allow';
  const ai = process.env.AG_AI === 'off' ? { status: 'disabled' } : await aiReview({ agent, receiver, amount, memo }, { verdict, risk, reasons });
  const out = { verdict, risk, reasons, signals, ai, contract: GUARD, checked_at: new Date().toISOString() };
  if (record) {
    recordEvent({ type: verdict, verdict, agent, receiver, amount, risk, reasons, memo });
  }
  return out;
}
