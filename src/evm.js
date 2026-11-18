'use strict';
// Tiny read-only EVM helper: JSON-RPC eth_call with endpoint failover,
// plus just enough ABI encode/decode for address/uint256/bool/string.
const { selector } = require('./keccak');

const CHAINS = {
  bsc: {
    label: 'BNB Smart Chain',
    chainId: 56,
    currency: 'BNB',
    rpcs: [
      'https://bsc-dataseed.binance.org',
      'https://bsc-dataseed1.defibit.io',
      'https://bsc-rpc.publicnode.com',
    ],
  },
  ethereum: {
    label: 'Ethereum Mainnet',
    chainId: 1,
    currency: 'ETH',
    rpcs: [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.llamarpc.com',
      'https://cloudflare-eth.com',
    ],
  },
  base: {
    label: 'Base',
    chainId: 8453,
    currency: 'ETH',
    rpcs: [
      'https://mainnet.base.org',
      'https://base-rpc.publicnode.com',
    ],
  },
};

const CHAIN_ALIASES = {
  bnb: 'bsc',
  binance: 'bsc',
  'bnb smart chain': 'bsc',
  eth: 'ethereum',
  mainnet: 'ethereum',
  'ethereum mainnet': 'ethereum',
};

function resolveChain(name) {
  if (!name) return null;
  const key = String(name).toLowerCase().trim();
  if (CHAINS[key]) return key;
  if (CHAIN_ALIASES[key]) return CHAIN_ALIASES[key];
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpcRequest(rpcs, method, params, timeoutMs = 9000) {
  let lastErr = null;
  // Two passes over the endpoint list: public RPCs rate-limit (HTTP 429)
  // under bursts, so back off and retry before giving up.
  for (let pass = 0; pass < 2; pass++) {
    for (const url of rpcs) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        const body = await res.json();
        if (body.error) {
          const msg = body.error.message || JSON.stringify(body.error);
          // A revert is deterministic — the same call reverts on every
          // endpoint, so fail over is pointless. Flag it and stop.
          if (/revert/i.test(msg)) {
            const e = new Error(`RPC error: ${msg}`);
            e.rpcRevert = true;
            throw e;
          }
          throw new Error(`RPC error: ${msg}`);
        }
        return body.result;
      } catch (err) {
        clearTimeout(timer);
        if (err.rpcRevert) throw err;
        lastErr = err;
      }
    }
    if (pass === 0) await sleep(700);
  }
  throw lastErr || new Error('All RPC endpoints failed');
}

function encodeAddress(addr) {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function encodeUint(n) {
  return BigInt(n).toString(16).padStart(64, '0');
}

function encodeCall(signature, args = []) {
  let data = selector(signature).slice(2);
  for (const arg of args) {
    if (arg.type === 'address') data += encodeAddress(arg.value);
    else if (arg.type === 'uint256') data += encodeUint(arg.value);
    else throw new Error(`Unsupported arg type ${arg.type}`);
  }
  return '0x' + data;
}

function decodeUint(hex) {
  if (!hex || hex === '0x') return null;
  return BigInt(hex.slice(0, 66));
}

function decodeBool(hex) {
  const v = decodeUint(hex);
  if (v === null) return null;
  return v !== 0n;
}

function decodeString(hex) {
  if (!hex || hex === '0x' || hex.length < 130) return null;
  try {
    const len = Number(BigInt('0x' + hex.slice(66, 130)));
    const dataHex = hex.slice(130, 130 + len * 2);
    if (dataHex.length < len * 2) return null;
    return Buffer.from(dataHex, 'hex').toString('utf8');
  } catch {
    return null;
  }
}

// Call one view function; returns decoded value or null when the call
// reverts / returns nothing / cannot be decoded / transport fails after
// retries. Never throws: a single flaky getter must not kill a whole
// check — it is reported as "unverified" instead. (checkMint separately
// probes eth_getCode first, which does throw on total RPC failure.)
async function tryView(rpcs, contract, signature, args, kind) {
  const data = encodeCall(signature, args);
  let result;
  try {
    result = await rpcRequest(rpcs, 'eth_call', [{ to: contract, data }, 'latest']);
  } catch {
    return null;
  }
  if (!result || result === '0x') return null;
  if (kind === 'uint') return decodeUint(result);
  if (kind === 'bool') return decodeBool(result);
  if (kind === 'string') return decodeString(result);
  return result;
}

// Try a list of candidate signatures for the same concept; returns
// { value, source } for the first that answers, else { value: null, source: null }.
async function tryCandidates(rpcs, contract, candidates, kind) {
  for (const cand of candidates) {
    const args = cand.args || [];
    const value = await tryView(rpcs, contract, cand.sig, args, kind);
    if (value !== null && value !== undefined) {
      return { value, source: cand.sig };
    }
  }
  return { value: null, source: null };
}

function formatNative(wei, currency) {
  if (wei === null || wei === undefined) return null;
  const w = BigInt(wei);
  const whole = w / 10n ** 18n;
  const frac = (w % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''} ${currency}`;
}

module.exports = {
  CHAINS,
  resolveChain,
  rpcRequest,
  tryView,
  tryCandidates,
  formatNative,
  encodeCall,
};
