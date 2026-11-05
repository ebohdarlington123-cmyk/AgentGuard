// Offline unit tests: node --test test/unit
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { buildDryQuoteRequest, scoreIntent } from '../../lib/intents.js';
import { chainSigCheck, chainOf } from '../../lib/chainsig.js';
import { evmCalldataRisk, solanaIxRisk } from '../../lib/modules/crosschain.js';
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const fakeQuote = (inUsd, outUsd) => async () => ({ source: 'mock', quote: { amountInUsd: String(inUsd), amountOutUsd: String(outUsd) } });
test('quote request is always dry', () => { assert.equal(buildDryQuoteRequest({ originAsset: 'a', destinationAsset: 'b', amount: 1, recipient: 'x.near' }).dry, true); });
test('chainOf resolves omft / hot assets', () => {
  assert.equal(chainOf('nep141:sol.omft.near'), 'sol'); assert.equal(chainOf('nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near'), 'eth');
  assert.equal(chainOf('nep245:v2_1.omni.hot.tg:56_11111111111111111111'), 'bsc'); assert.equal(chainOf('nep141:wrap.near'), 'near');
});
test('chain-sig: burn, NEAR-acct-on-EVM, bad SOL address blocked', () => {
  assert.ok(chainSigCheck({ destinationAsset: 'nep141:eth.omft.near', recipient: '0x000000000000000000000000000000000000dEaD' }).block);
  assert.ok(chainSigCheck({ destinationAsset: 'nep141:eth.omft.near', recipient: 'alice.near' }).block);
  assert.ok(chainSigCheck({ destinationAsset: 'nep141:sol.omft.near', recipient: '0OIl-not-base58' }).block);
  assert.ok(!chainSigCheck({ destinationAsset: 'nep141:sol.omft.near', recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' }).block);
});
test('scoreIntent: clean swap allow, bad quote warn, burn block, never executes', async () => {
  const base = { originAsset: 'nep141:wrap.near', destinationAsset: USDC, amount: '1000000000000000000000000', recipient: 'merchant.near' };
  const ok = await scoreIntent(base, { quoteFn: fakeQuote(4, 3.99) }); assert.equal(ok.verdict, 'allow'); assert.equal(ok.executed, false);
  assert.equal((await scoreIntent(base, { quoteFn: fakeQuote(4, 3) })).verdict, 'warn');
  assert.equal((await scoreIntent({ ...base, slippageBps: 1000 }, { quoteFn: fakeQuote(4, 4) })).verdict, 'warn');
  assert.equal((await scoreIntent({ ...base, destinationAsset: 'nep141:eth.omft.near', recipient: '0x0000000000000000000000000000000000000000' }, { quoteFn: fakeQuote(4, 4) })).verdict, 'block');
});
test('ported ChainMedic checks: drainer approvals', () => {
  assert.ok(evmCalldataRisk('0x095ea7b3' + '0'.repeat(24) + '1'.repeat(40) + 'f'.repeat(64)).length);
  assert.ok(solanaIxRisk([{ type: 'approve' }]).length);
});
