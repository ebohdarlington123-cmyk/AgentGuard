// Offline unit tests for optional ChainMedic-derived Solana/EVM modules.
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { solanaAddressRisk, evmAddressRisk, scamBaitToken, evmCalldataRisk, solanaIxRisk } from '../../lib/modules/crosschain.js';
test('address validation', () => {
  assert.equal(solanaAddressRisk('So11111111111111111111111111111111111111112').invalid, false);
  assert.equal(solanaAddressRisk('0xabc').invalid, true);
  assert.equal(evmAddressRisk('0x000000000000000000000000000000000000dEaD').invalid, false);
  assert.equal(evmAddressRisk('alice.near').invalid, true);
});
test('scam-bait token names', () => { assert.ok(scamBaitToken('FREE AIRDROP claim.io')); assert.ok(!scamBaitToken('USDC')); });
test('EVM drainer calldata', () => {
  const unlimited = '0x095ea7b3' + '0'.repeat(24) + '1'.repeat(40) + 'f'.repeat(64);
  assert.equal(evmCalldataRisk(unlimited).length, 1);
  assert.equal(evmCalldataRisk('0xd505accf00').length, 1);
  assert.equal(evmCalldataRisk('0xa9059cbb00').length, 0);
});
test('Solana approve/setAuthority', () => { assert.equal(solanaIxRisk([{ type: 'approve' }, { type: 'setAuthority' }, { type: 'transfer' }]).length, 2); });
