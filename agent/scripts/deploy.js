// Idempotent testnet setup for AgentGuard v2 (swarm + pending).
// Keys are written to ~/.near-credentials only; nothing sensitive is printed.
import fs from 'node:fs';
import nearAPI from 'near-api-js';
import { account, exists, keyStore, KeyPair, N, ROOT, GUARD, NETWORK } from '../lib/near.js';

const { transactions: T } = nearAPI;
const WASM = new URL('../../contract/target/near/agentguard_policy.wasm', import.meta.url);
const FC_METHODS = ['execute_transfer', 'request_transfer'];
const root = await account(ROOT);

async function sub(name, bal, keyPair) {
  const id = `${name}.${ROOT}`;
  if (await exists(id)) { console.log('exists', id); return id; }
  const kp = keyPair || KeyPair.fromRandom('ed25519');
  await root.createAccount(id, kp.getPublicKey(), BigInt(N(bal)));
  await keyStore.setKey(NETWORK, id, kp);
  console.log('created', id);
  return id;
}

async function ensureFcAgent(name, bal = '0.25') {
  const id = `${name}.${ROOT}`;
  if (await exists(id)) {
    console.log('exists', id);
    // Ensure FC key for GUARD methods is present in keystore + on account.
    const a = await account(id);
    const keys = await a.getAccessKeys();
    const has = keys.some((k) => {
      const p = k.access_key.permission;
      return p !== 'FullAccess' && p.FunctionCall?.receiver_id === GUARD &&
        FC_METHODS.every((m) => p.FunctionCall.method_names.includes(m));
    });
    if (!has) {
      // Need a full-access key on ROOT to add a key to a subaccount we don't fully control.
      // For brand-new agents we create FC-only; for existing v1 agent we create agent2/agent3 instead.
      console.log('note: existing', id, 'missing v2 FC methods; use a fresh agent subaccount');
    }
    return id;
  }
  const kp = KeyPair.fromRandom('ed25519');
  await root.signAndSendTransaction({
    receiverId: id,
    actions: [
      T.createAccount(),
      T.transfer(BigInt(N(bal))),
      T.addKey(kp.getPublicKey(), T.functionCallAccessKey(GUARD, FC_METHODS, BigInt(N('0.25')))),
    ],
  });
  await keyStore.setKey(NETWORK, id, kp);
  console.log('created FC-only agent', id);
  return id;
}

// 1. Deploy guard2 contract account
const guardName = GUARD.endsWith(`.${ROOT}`) ? GUARD.slice(0, -(`.${ROOT}`.length)) : 'guard2';
await sub(guardName, '2');
const guard = await account(GUARD);
const st = await guard.state();
const force = process.argv.includes('--redeploy');
if (st.code_hash === '11111111111111111111111111111111' || force) {
  await guard.deployContract(fs.readFileSync(WASM));
  console.log('deployed wasm to', GUARD);
}
try {
  await guard.viewFunction({ contractId: GUARD, methodName: 'get_config' });
  console.log('already initialized');
} catch {
  await guard.functionCall({ contractId: GUARD, methodName: 'new', args: { admin: ROOT, report_threshold: 2 } });
  console.log('initialized');
}

for (const n of ['merchant', 'scam', 'rep1', 'rep2']) await sub(n, '0.2');

// 2. Single-agent path (v1-compatible): agent2 on guard2
const agentId = await ensureFcAgent('agent2', '0.15');
let pol = await guard.viewFunction({ contractId: GUARD, methodName: 'get_agent', args: { agent_id: agentId } });
if (!pol) {
  await root.functionCall({
    contractId: GUARD,
    methodName: 'register_agent',
    args: { agent_id: agentId, per_tx_cap: N('0.5'), daily_cap: N('1'), allowlist: null },
    attachedDeposit: BigInt(N('0.8')),
  });
  console.log('registered agent2: per_tx 0.5, daily 1, vault 0.8 NEAR');
} else {
  console.log('agent2 already registered');
}

// 3. Swarm path: shared vault "crew" with agent3 + agent4
const swarmId = 'crew';
let swarm = null;
try { swarm = await guard.viewFunction({ contractId: GUARD, methodName: 'get_swarm', args: { swarm_id: swarmId } }); } catch {}
if (!swarm) {
  await root.functionCall({
    contractId: GUARD,
    methodName: 'register_swarm',
    args: { swarm_id: swarmId, per_tx_cap: N('0.4'), daily_cap: N('0.8'), allowlist: null },
    attachedDeposit: BigInt(N('0.8')),
  });
  console.log('registered swarm crew: shared per_tx 0.4, daily 0.8, vault 0.8');
} else {
  console.log('swarm crew exists, balance', swarm.balance);
}

const agent3 = await ensureFcAgent('agent3', '0.15');
const agent4 = await ensureFcAgent('agent4', '0.15');
for (const [id, ptx, day] of [[agent3, '0.3', '0.5'], [agent4, '0.3', '0.5']]) {
  const existing = await guard.viewFunction({ contractId: GUARD, methodName: 'get_agent', args: { agent_id: id } });
  if (!existing) {
    await root.functionCall({
      contractId: GUARD,
      methodName: 'add_agent',
      args: { swarm_id: swarmId, agent_id: id, per_tx_cap: N(ptx), daily_cap: N(day) },
    });
    console.log('added', id, 'to crew');
  } else {
    console.log(id, 'already in', existing.swarm_id);
  }
}

console.log('done; contract =', GUARD);
console.log('single agent =', agentId);
console.log('swarm agents =', agent3, agent4);
