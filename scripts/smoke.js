'use strict';
// Live read-only smoke test: runs MintCheck against real contracts on BSC
// and writes the full JSON outputs to examples/ for the README.
// Usage: node scripts/smoke.js
const fs = require('node:fs');
const path = require('node:path');
const { checkMint } = require('../src/mintcheck');

const WALLET = '0x3d0031aF5924b5C6d4D6C52A14235F54aD8B476D'; // user's agentic wallet (read-only checks)

const CASES = [
  {
    name: 'taptap-nib',
    input: { chain: 'bsc', contract: '0x7374f0379F5b2689B906D47Da708B394F1910B23', wallet: WALLET },
  },
  {
    name: 'contextgraph-nodes',
    input: { chain: 'bsc', contract: '0x08b1323a74530bedd2188b458ebcc856315d8e0f', wallet: WALLET },
  },
];

(async () => {
  const outDir = path.join(__dirname, '..', 'examples');
  fs.mkdirSync(outDir, { recursive: true });
  for (const c of CASES) {
    const started = Date.now();
    const result = await checkMint(c.input);
    const ms = Date.now() - started;
    const file = path.join(outDir, `${c.name}.json`);
    fs.writeFileSync(file, JSON.stringify({ request: c.input, responseMs: ms, response: result }, null, 2));
    console.log(`\n=== ${c.name} (${ms} ms) -> ${file}`);
    console.log(JSON.stringify(result, null, 2));
  }
})().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
