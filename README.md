# AgentGuard (NEAR Hackathon)

A firewall that sits in front of an AI agent's payments on NEAR. The agent holds only a **function-call access key** scoped to `execute_transfer` / `request_transfer` on the guard contract. Every payment has to pass two checks:

1. an off-chain **risk score** (`agent/lib/score.js`) that returns `allow`, `pending` (medium risk) or `block`, with reasons
2. the on-chain **policy contract** (`contract/`), which enforces shared swarm caps, per-agent caps, allow/block lists, and a community blocklist

Every rejected payment is recorded on-chain as an incident. Medium-risk payments can be parked as **pending** for the owner to approve or reject (on-chain and via the API).

**Testnet contract (v2, swarm + pending):** `guard2.agentguard-15173.testnet`
(v1 `guard.agentguard-15173.testnet` is retired; set `AG_CONTRACT` to override.)

## Try it
- `cd contract && cargo test`: you should see **20** unit tests pass.
- `cd agent && npm i && npm run e2e`: live testnet e2e against `guard2` (swarm + pending + attacks).
- `cd agent && npm start`, then `curl "localhost:8787/score?receiver=scam.agentguard-15173.testnet"`: `"verdict": "block"`.
- Latency: `cd agent && AG_AI=off node scripts/bench-score.js` (warm `/score` target &lt; 1s).

## Disclosure
All code here was written during the NEAR HACKATHON window, starting Nov 3, 2026. Some of the risk ideas are adapted from the author's earlier Solana project, ChainMedic.

## Swarm mode (Illia "guardrails for agent swarms")

Several agent accounts share one owner-funded **swarm vault** with shared per-tx / daily caps. Each agent also has its own per-tx / daily caps on top. The owner can `add_agent` / `remove_agent`.

- Contract: `register_swarm`, `add_agent`, `remove_agent`, `deposit_swarm`, `set_swarm_caps`, `get_swarm`, `list_swarms`
- `register_agent` still works (creates a one-agent swarm named after the agent) for backward-compatible views via `get_agent`
- Live demo swarm: `crew` with `agent3` + `agent4` on testnet

## Human approval (medium risk → pending)

Score verdicts:
- `risk >= 100` → `block`
- `risk >= 40` → `pending` (was "warn")
- else → `allow`

On-chain: agent calls `request_transfer` → status `PENDING`; owner calls `approve_pending` / `reject_pending`.
Off-chain API (used by the dashboard):

| Method | Path | Body / query | Notes |
|--------|------|--------------|-------|
| GET | `/pending` | `?status=pending\|all` or `?id=` | Returns `{ pending: [...] }` |
| POST | `/pending` | `{agent,receiver,amount,memo?,onchain_pending_id?}` | Manually park a payment |
| POST | `/approve` | `{ id, action: 'approve'\|'reject', decision? }` | `decision` is an alias for `action`. Optional header `x-ag-approve-secret` must match `AG_APPROVE_SECRET` when that env is set. On approve, the API executes (or resolves the on-chain pending) using the owner/agent keys in `~/.near-credentials`. |

`guardedPay` parks medium-risk payments into this queue (and prefers an on-chain pending when possible).

## Live activity feed

Every allow / block / pending / approve / reject decision is recorded in-memory and exposed to the dashboard.

| Method | Path | Response |
|--------|------|----------|
| GET | `/events` | `{ schema_version: 1, events: [ ... ] }` |
| GET | `/events/stream` | SSE. Hello event, then `event: decision` with JSON data; keepalive pings |

### Event schema (`schema_version: 1`)

```json
{
  "id": 1,
  "ts": "2026-11-05T04:00:00.000Z",
  "type": "allow|block|pending|approve|reject|warn",
  "verdict": "allow",
  "agent": "agent2.agentguard-15173.testnet",
  "receiver": "merchant.agentguard-15173.testnet",
  "amount": "50000000000000000000000",
  "risk": 0,
  "reasons": [],
  "pending_id": null,
  "memo": "api fee",
  "meta": null
}
```

Query params on `/events`: `since_id`, `limit` (default 100), `type`.

## Speed (TTL cache)

`agent/lib/cache.js` caches contract views (`receiver_status`, `check_transfer`), account info and nearblocks age lookups (default TTL 30s / 120s). Warm `/score` is targeted under 1 second. Tune with `AG_CACHE_TTL_MS` / `AG_AGE_CACHE_TTL_MS`.

## Scoring API endpoints

- `GET /health` → `{ ok, contract, features, event_schema, cache }`
- `GET /score?receiver=&agent=&amount=&memo=&park=0|1&record=0|1`
- `GET /score-intent?...` (dry Intents quote)
- `GET /agent?id=`, `GET /swarm?id=`, `GET /blocklist`
- `GET /pending`, `POST /pending`, `POST /approve`
- `GET /events`, `GET /events/stream`

## NEAR Intents dry-quote risk check (no execution)

NEAR Intents has no testnet, so AgentGuard only requests **`dry: true`** quotes from the 1Click API (`agent/lib/intents.js`). It never deposits or signs anything. If the quote API refuses (it may need a JWT: set `ONECLICK_JWT`, which is never logged), it falls back to a price estimate from `/v0/tokens`.

- `scoreIntent({ originAsset, destinationAsset, amount, recipient, refundTo?, slippageBps?, memo? })` returns `{ verdict, risk, reasons, quote, chain_sig, executed: false }`
- `score({ ..., intent })` merges intent risk into the main score
- HTTP: `GET /score-intent?originAsset=nep141:wrap.near&destinationAsset=nep141:sol.omft.near&amount=1000000000000000000000000&recipient=<addr>`

**Chain-signatures destination check** (`agent/lib/chainsig.js`, stub): this resolves the destination chain from the asset id. It blocks burn/null addresses, malformed EVM/Solana addresses, NEAR accounts used as foreign-chain recipients, and anything on the `AGENTGUARD_XCHAIN_BLOCKLIST` env list. MPC-derived address verification is still TODO.

**Optional Solana/EVM modules** (`agent/lib/modules/crosschain.js`, ported from ChainMedic heuristics): these flag unlimited ERC-20 `approve`, `setApprovalForAll`, `permit`, SPL `approve`/`setAuthority`, and scam-bait token names. Use them through `score({ ..., evmCalldata, solanaIxs })`.

Offline tests: `cd agent && node --test test/unit/*.test.js`

## Judge quick-start (about 5 minutes)
1. **Contract unit tests:** `cd contract && cargo test` → `20 passed`.
2. **Live testnet e2e:** `cd agent && npm i && npm run e2e` (needs `~/.near-credentials` for `agentguard-15173.testnet`).
3. **Scoring API:** `cd agent && npm start`, then `curl "localhost:8787/score?receiver=scam.agentguard-15173.testnet"` → `"verdict":"block"`.
4. **Dashboard:** `cd dashboard && npm run dev` → http://localhost:3000. Live feed, pending Approve/Reject, policy, blocklist.
5. **Public demo tunnels:** `ops/public-demo.sh` (API on :8787, dashboard on :3000; do not collide with :8790/:8791).

## Dashboard (`dashboard/`)
Static page (`public/index.html`) + Vercel proxy (`api/proxy.js`) that allowlists:
`/health`, `/score`, `/agent`, `/blocklist`, `/events`, `/events/stream`, `/pending` (GET) and `/approve` (POST).
SSE is streamed unbuffered. If `AG_APPROVE_SECRET` is set on the API, set the same env on the proxy so it forwards `x-ag-approve-secret`.
- Local: `npm run dev`. Set `AG_API_URL` if the API isn't at `http://localhost:8787`.
- Do not put secrets in the browser; the proxy adds the approve header server-side.

## Deploy (testnet)
```bash
cd contract && cargo near build non-reproducible-wasm
cd ../agent && node scripts/deploy.js          # creates/updates guard2 + agents + crew swarm
# force wasm replace: node scripts/deploy.js --redeploy
```
Keys stay only in `~/.near-credentials`. Nothing secret is printed.

## NEAR AI Cloud reasoning (optional, advisory)

If `NEARAI_API_KEY` is set, `/score` also sends the proposed transaction and the rule-based findings to NEAR AI Cloud (`https://cloud-api.near.ai/v1/chat/completions`). Result is an advisory `ai` field and **never** changes `verdict`/`risk`. Set `AG_AI=off` to disable.

## Note on `integration/` (dropped)
An earlier near-workspaces sandbox suite was removed because it duplicated the live testnet e2e suite. Recoverable from git history if needed.
