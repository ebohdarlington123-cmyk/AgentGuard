import nearAPI from 'near-api-js';
import os from 'node:os'; import path from 'node:path';
const { connect, keyStores, KeyPair, utils } = nearAPI;
export const NETWORK = process.env.NEAR_NETWORK || 'testnet';
export const ROOT = process.env.AG_ROOT || 'agentguard-15173.testnet';
// v2 contract (swarm + pending). Override with AG_CONTRACT.
export const GUARD = process.env.AG_CONTRACT || `guard2.${ROOT}`;
export const keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
let _near;
export async function near() {
  _near ??= await connect({ networkId: NETWORK, keyStore, nodeUrl: process.env.NEAR_RPC || 'https://rpc.testnet.near.org' });
  return _near;
}
export const account = async (id) => (await near()).account(id);
export const N = (x) => utils.format.parseNearAmount(String(x));
export const fmt = (y) => utils.format.formatNearAmount(String(y), 4);
export async function exists(id) { try { await (await account(id)).state(); return true; } catch { return false; } }
export async function view(method, args = {}) { return (await account(ROOT)).viewFunction({ contractId: GUARD, methodName: method, args }); }
export { KeyPair, utils };
