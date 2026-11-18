'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { keccak256, selector } = require('../src/keccak');
const evm = require('../src/evm');
const { checkMint } = require('../src/mintcheck');

test('keccak256 matches known vectors', () => {
  assert.equal(
    keccak256('').toString('hex'),
    'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
  );
  assert.equal(
    keccak256('hello world').toString('hex'),
    '47173285a8d7341e5e972fc677286384f802f8ef42a5ec5f03bbfa254cb01fad'
  );
});

test('function selectors match canonical ERC-721 values', () => {
  assert.equal(selector('totalSupply()'), '0x18160ddd');
  assert.equal(selector('balanceOf(address)'), '0x70a08231');
  assert.equal(selector('name()'), '0x06fdde03');
  assert.equal(selector('symbol()'), '0x95d89b41');
  assert.equal(selector('ownerOf(uint256)'), '0x6352211e');
});

test('encodeCall builds correct calldata', () => {
  const data = evm.encodeCall('balanceOf(address)', [
    { type: 'address', value: '0x3d0031aF5924b5C6d4D6C52A14235F54aD8B476D' },
  ]);
  assert.equal(
    data,
    '0x70a082310000000000000000000000003d0031af5924b5c6d4d6c52a14235f54ad8b476d'
  );
});

test('formatNative renders wei amounts', () => {
  assert.equal(evm.formatNative(0n, 'BNB'), '0 BNB');
  assert.equal(evm.formatNative(10n ** 18n, 'ETH'), '1 ETH');
  assert.equal(evm.formatNative(25n * 10n ** 16n, 'BNB'), '0.25 BNB');
  assert.equal(evm.formatNative(null, 'BNB'), null);
});

test('resolveChain handles aliases', () => {
  assert.equal(evm.resolveChain('bsc'), 'bsc');
  assert.equal(evm.resolveChain('ETH'), 'ethereum');
  assert.equal(evm.resolveChain('bnb'), 'bsc');
  assert.equal(evm.resolveChain('solana'), null);
});

// ---- checkMint verdict logic with a stubbed transport ----

const WALLET = '0x3d0031aF5924b5C6d4D6C52A14235F54aD8B476D';
const CONTRACT = '0x1111111111111111111111111111111111111111';

function stubTransport(answers) {
  // answers: { 'sig': value } — missing sig => null (call "reverts")
  const origRpc = evm.rpcRequest;
  const origView = evm.tryView;
  const origCand = evm.tryCandidates;
  evm.rpcRequest = async () => '0x60006000';
  evm.tryView = async (rpcs, contract, sig) => (sig in answers ? answers[sig] : null);
  evm.tryCandidates = async (rpcs, contract, candidates) => {
    for (const c of candidates) {
      if (c.sig in answers) return { value: answers[c.sig], source: c.sig };
    }
    return { value: null, source: null };
  };
  return () => {
    evm.rpcRequest = origRpc;
    evm.tryView = origView;
    evm.tryCandidates = origCand;
  };
}

test('verdict CLOSED when mintOpen() is false (TapTap-shaped answers)', async () => {
  const restore = stubTransport({
    'name()': 'Nib Collection',
    'symbol()': 'NIB',
    'totalSupply()': 1187n,
    'maxSupply()': 10000n,
    'mintOpen()': false,
    'mintCostBNB(address,uint256)': 0n,
    'balanceOf(address)': 0n,
    'mintedBy(address)': 0n,
  });
  try {
    const r = await checkMint({ chain: 'bsc', contract: CONTRACT, wallet: WALLET });
    assert.equal(r.verdict, 'CLOSED');
    assert.equal(r.supply.minted, '1187');
    assert.equal(r.supply.max, '10000');
    assert.equal(r.supply.remaining, '8813');
    assert.equal(r.mint.priceWei, '0');
    assert.equal(r.walletInfo.mintedByWallet, '0');
  } finally {
    restore();
  }
});

test('verdict OPEN & FREE when open and price is zero', async () => {
  const restore = stubTransport({
    'totalSupply()': 10n,
    'maxSupply()': 100n,
    'saleActive()': true,
    'mintPrice()': 0n,
  });
  try {
    const r = await checkMint({ chain: 'bsc', contract: CONTRACT, wallet: null });
    assert.equal(r.verdict, 'OPEN & FREE');
    assert.equal(r.mint.openSource, 'saleActive()');
  } finally {
    restore();
  }
});

test('verdict OPEN BUT PAID when price > 0', async () => {
  const restore = stubTransport({
    'totalSupply()': 10n,
    'mintOpen()': true,
    'price()': 5n * 10n ** 16n,
  });
  try {
    const r = await checkMint({ chain: 'ethereum', contract: CONTRACT, wallet: null });
    assert.equal(r.verdict, 'OPEN BUT PAID');
    assert.equal(r.mint.price, '0.05 ETH');
  } finally {
    restore();
  }
});

test('verdict SOLD OUT takes precedence', async () => {
  const restore = stubTransport({
    'totalSupply()': 100n,
    'maxSupply()': 100n,
    'mintOpen()': true,
    'mintPrice()': 0n,
  });
  try {
    const r = await checkMint({ chain: 'base', contract: CONTRACT, wallet: null });
    assert.equal(r.verdict, 'SOLD OUT');
    assert.equal(r.supply.remaining, '0');
  } finally {
    restore();
  }
});

test('unknown ABI is reported honestly, never guessed', async () => {
  const restore = stubTransport({ 'totalSupply()': 42n });
  try {
    const r = await checkMint({ chain: 'bsc', contract: CONTRACT, wallet: WALLET });
    assert.equal(r.verdict, 'UNKNOWN — INSUFFICIENT ON-CHAIN DATA');
    assert.equal(r.mint.open, null);
    assert.equal(r.mint.priceWei, null);
    assert.ok(r.unverifiedChecks.length >= 3);
  } finally {
    restore();
  }
});

test('per-wallet remaining allowance is computed', async () => {
  const restore = stubTransport({
    'totalSupply()': 5n,
    'mintOpen()': true,
    'mintPrice()': 0n,
    'balanceOf(address)': 2n,
    'numberMinted(address)': 2n,
    'maxPerWallet()': 3n,
  });
  try {
    const r = await checkMint({ chain: 'bsc', contract: CONTRACT, wallet: WALLET });
    assert.equal(r.walletInfo.remainingAllowance, '1');
    assert.equal(r.verdict, 'OPEN & FREE');
  } finally {
    restore();
  }
});
