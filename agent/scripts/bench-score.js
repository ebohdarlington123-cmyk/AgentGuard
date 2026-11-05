// Measure /score latency cold vs warm (cache). Usage: node scripts/bench-score.js
import { score } from '../lib/score.js';
import { cacheClear } from '../lib/cache.js';
import { ROOT } from '../lib/near.js';

const AGENT = `agent2.${ROOT}`;
const MERCHANT = `merchant.${ROOT}`;
process.env.AG_AI = 'off'; // isolate cache effect from AI

async function once(label) {
  const t0 = performance.now();
  const s = await score({ agent: AGENT, receiver: MERCHANT, amount: '10000000000000000000000', memo: 'bench' });
  const ms = performance.now() - t0;
  console.log(`${label}: ${ms.toFixed(1)}ms verdict=${s.verdict} risk=${s.risk}`);
  return ms;
}

cacheClear();
const cold = await once('cold');
const warm1 = await once('warm1');
const warm2 = await once('warm2');
const warm3 = await once('warm3');
const warmAvg = (warm1 + warm2 + warm3) / 3;
console.log(JSON.stringify({ cold_ms: Math.round(cold), warm_avg_ms: Math.round(warmAvg), target_warm_under_ms: 1000, ok: warmAvg < 1000 }, null, 2));
