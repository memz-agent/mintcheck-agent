# MintCheck — Free-Mint Lead Verifier Agent

**MintCheck checks a "free mint" lead against the blockchain itself before you waste time or gas on it.**

Give it a chain and an NFT contract address (plus your wallet, optionally) and it answers, from live on-chain reads only:

- Is minting **open** right now?
- What does one mint **actually cost** — is it really free (0), and what would *your* wallet pay vs. the base price?
- How many are **minted vs. the max supply** — how much room is left?
- How many has **your wallet** already minted, and what is its remaining per-wallet allowance?

It ends with a plain verdict: **OPEN & FREE**, **OPEN BUT PAID**, **CLOSED**, **SOLD OUT** — or an honest **OPEN — PRICE UNVERIFIED** / **UNKNOWN** when the contract doesn't expose enough to decide. MintCheck never guesses: every value in the response names the exact contract function it came from, and anything the contract doesn't answer is listed under `unverifiedChecks`.

Built for the zkVerify AgentGames **Wildcard Track** by [memz-agent](https://github.com/memz-agent). It mirrors a real daily workflow: free-mint leads arrive constantly, and most are closed, paid, or sold out by the time you hear about them.

## Live endpoint

<!-- PUBLIC_URL: replace the line below with the production URL after deploy (see "Deploy"). -->
Local: `http://localhost:3000` — public production URL: **https://mintcheck-agent-production.up.railway.app/agent** (the code is deploy-ready; see [Deploy](#deploy)).

## Call it

Health check:

```bash
curl https://<your-deployment>/health
# {"ok":true,"agent":"mintcheck","version":"1.0.0","time":"…"}
```

Check a mint lead:

```bash
curl -X POST https://<your-deployment>/agent \
  -H 'content-type: application/json' \
  -d '{"chain":"bsc","contract":"0x7374f0379F5b2689B906D47Da708B394F1910B23","wallet":"0x3d0031aF5924b5C6d4D6C52A14235F54aD8B476D"}'
```

Request fields: `chain` (`bsc` | `ethereum` | `base`), `contract` (required), `wallet` (optional — enables per-wallet price, minted count, and allowance).

## Worked examples (real output, recorded 2026-11-18)

### 1. TapTap Nib Collection (BSC) — a "free mint" that is actually CLOSED

Contract `0x7374f0379F5b2689B906D47Da708B394F1910B23`, wallet `0x3d0031…476D`:

```json
{
  "verdict": "CLOSED",
  "summary": "Nib Collection (NIB) on BNB Smart Chain: verdict CLOSED. Minted 1187/10000 (8813 remaining). Mint open flag (mintOpen()): false. Mint price (mintCostBNB(address,uint256)): 0 BNB. Base price (mintPrice()) is 1 BNB — the wallet-specific cost above is what this wallet would actually pay. Wallet has minted 0 so far.",
  "supply": { "minted": "1187", "max": "10000", "remaining": "8813" },
  "mint": { "open": false, "price": "0 BNB", "basePrice": "1 BNB" }
}
```

Note the nuance MintCheck catches: the base price is 1 BNB, but this wallet's own cost function returns 0 (free first mint for eligible wallets) — and none of it matters today, because the owner has closed the mint. Full response: [examples/taptap-nib.json](examples/taptap-nib.json).

### 2. Contextgraph Nodes (BSC) — OPEN, price honestly unverified

Contract `0x08b1323a74530bedd2188b458ebcc856315d8e0f`, same wallet:

```json
{
  "verdict": "OPEN — PRICE UNVERIFIED",
  "summary": "Contextgraph Nodes (NODE) on BNB Smart Chain: verdict OPEN — PRICE UNVERIFIED. Minted so far: 2320 (max supply not exposed). Mint open flag (mintOpen()): true.",
  "supply": { "minted": "2320", "mintedSource": "totalNodes()", "max": null },
  "mint": { "open": true, "price": null },
  "walletInfo": { "balance": "2" }
}
```

This contract mints free via a per-wallet puzzle answer, so it exposes no standard price getter — MintCheck says so instead of inventing a price. It still verifies the mint is open, counts 2,320 nodes minted (via the contract's own `totalNodes()`), and confirms the wallet holds 2. Full response: [examples/contextgraph-nodes.json](examples/contextgraph-nodes.json).

## How it works

MintCheck is read-only: it sends `eth_call` probes to public RPCs (with failover + retry) and **never signs or sends a transaction**.

1. `eth_getCode` — is there a contract at the address at all?
2. Identity & supply — `name()`, `symbol()`, and the first answering minted-count getter (`totalSupply()`, `totalMinted()`, `mintedCount()`, `currentSupply()`, `totalNodes()`, `supply()`), plus max supply (`maxSupply()`, `MAX_SUPPLY()`, `totalMaxSupply()`, `collectionSize()`).
3. Open flag — the first answering of `mintOpen()`, `mintingOpen()`, `isMintOpen()`, `publicMintOpen()`, `mintActive()`, `saleActive()`, `isSaleActive()`, …
4. Price — base price from no-arg getters (`mintPrice()`, `publicMintPrice()`, `price()`, `cost()`, …); if a wallet is given, wallet-specific cost getters (`mintCostBNB(address,uint256)`, `mintCost(address,uint256)`, …) override it, because that is what the wallet would actually pay.
5. Wallet — `balanceOf(address)`, per-wallet minted count (`mintedBy(address)`, `numberMinted(address)`, …), and per-wallet limit (`maxPerWallet()`, …) → remaining allowance.
6. Verdict — derived **only** from values the contract actually returned; SOLD OUT (minted ≥ max) takes precedence, then CLOSED (open flag false), then OPEN & FREE / OPEN BUT PAID by price.

The codebase is zero-dependency Node.js (including a small hand-rolled, test-vector-validated Keccak-256 for function selectors), so it runs anywhere Node ≥ 18 runs.

## Run it yourself

```bash
npm start          # node server.js — listens on $PORT (default 3000)
npm test           # unit tests: keccak vectors, ABI encoding, verdict logic (11 tests)
npm run smoke      # live read-only smoke test vs. the two example contracts -> examples/
```

## Deploy

Zero dependencies and a single start command (`node server.js`, honors `$PORT`), with `railway.json` and a `Procfile` included. On Railway: create a service from this repo in any project, generate a public domain under Settings → Networking, and the agent is live at `https://<service>-production.up.railway.app/agent`.

## License

MIT — see [LICENSE](LICENSE) (`SPDX-License-Identifier: MIT`).
