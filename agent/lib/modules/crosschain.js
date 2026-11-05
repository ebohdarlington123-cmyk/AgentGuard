// Optional Solana/EVM checks ported from ChainMedic (/workspace/chainmedic/server/lib/solana.ts heuristics). Offline, no RPC.
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BAIT = /(claim|reward|airdrop|bonus|free|\.com|\.io|https?:|t\.me|visit)/i; // ChainMedic scam-bait token name rule
export function solanaAddressRisk(addr) {
  if (!B58.test(addr)) return { invalid: true, reasons: [] };
  const reasons = []; if (/^(1{6,}|So1{10,})/.test(addr) && addr !== 'So11111111111111111111111111111111111111112') reasons.push('Solana recipient looks like a vanity/system-lookalike address');
  return { invalid: false, reasons };
}
export function evmAddressRisk(addr) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return { invalid: true, reasons: [] };
  return { invalid: false, reasons: [] };
}
export function scamBaitToken(name = '') { return BAIT.test(name); }
// EVM calldata red flags (drainer approvals), as in ChainMedic's "approvals/delegates can move tokens" flag.
export function evmCalldataRisk(data = '') {
  const d = data.toLowerCase(); const reasons = [];
  if (d.startsWith('0x095ea7b3') && /f{60,}/.test(d.slice(74))) reasons.push('unlimited ERC-20 approve()');
  if (d.startsWith('0xa22cb465') && d.endsWith('1')) reasons.push('setApprovalForAll(true) grants all NFTs');
  if (d.startsWith('0xd505accf')) reasons.push('ERC-20 permit signature (gasless approval, common drainer)');
  return reasons;
}
// Solana tx red flags: SPL Approve (delegate) / SetAuthority instructions.
export function solanaIxRisk(ixs = []) {
  const reasons = [];
  for (const ix of ixs) {
    if (ix.type === 'approve' || ix.type === 'approveChecked') reasons.push('SPL token approve: delegate can move your tokens');
    if (ix.type === 'setAuthority') reasons.push('setAuthority: hands control of a token account/mint to someone else');
  }
  return reasons;
}
