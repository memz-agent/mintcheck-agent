'use strict';
// MintCheck agent — plain Node HTTP server, zero dependencies.
// POST /agent  {"chain":"bsc","contract":"0x...","wallet":"0x..."} -> verdict JSON
// GET  /health -> {"ok":true,...}
// GET  /       -> usage info
const http = require('node:http');
const { resolveChain, CHAINS } = require('./src/evm');
const { checkMint } = require('./src/mintcheck');

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PORT = process.env.PORT || 3000;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, agent: 'mintcheck', version: '1.0.0', time: new Date().toISOString() });
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, {
      agent: 'MintCheck',
      what: 'Verifies NFT free-mint leads on-chain: is minting open, is it really free, how much supply is left, and is a wallet eligible.',
      usage: {
        method: 'POST',
        path: '/agent',
        body: { chain: 'bsc | ethereum | base', contract: '0x… (required)', wallet: '0x… (optional)' },
      },
      chains: Object.keys(CHAINS),
      health: '/health',
    });
  }

  if (req.method === 'POST' && (url.pathname === '/agent' || url.pathname === '/agent/')) {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 16384) req.destroy();
    });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'INVALID_JSON', summary: 'Request body must be valid JSON.' });
      }
      const chain = resolveChain(body.chain);
      if (!chain) {
        return sendJson(res, 400, {
          ok: false,
          error: 'UNSUPPORTED_CHAIN',
          summary: `Unsupported chain "${body.chain}". Supported: ${Object.keys(CHAINS).join(', ')}.`,
        });
      }
      if (!body.contract || !ADDRESS_RE.test(body.contract)) {
        return sendJson(res, 400, { ok: false, error: 'INVALID_CONTRACT', summary: '"contract" must be a 0x-prefixed 20-byte address.' });
      }
      if (body.wallet && !ADDRESS_RE.test(body.wallet)) {
        return sendJson(res, 400, { ok: false, error: 'INVALID_WALLET', summary: '"wallet" must be a 0x-prefixed 20-byte address.' });
      }
      try {
        const result = await checkMint({ chain, contract: body.contract, wallet: body.wallet || null });
        return sendJson(res, result.ok ? 200 : 404, result);
      } catch (err) {
        return sendJson(res, 502, {
          ok: false,
          error: 'RPC_UNREACHABLE',
          summary: `Could not reach any public RPC for chain "${chain}": ${err.message}`,
        });
      }
    });
    return;
  }

  return sendJson(res, 404, { ok: false, error: 'NOT_FOUND', summary: 'Use GET /health or POST /agent.' });
});

server.listen(PORT, () => {
  console.log(`MintCheck listening on :${PORT}`);
});
