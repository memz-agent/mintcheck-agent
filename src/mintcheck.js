'use strict';
// MintCheck core: read-only on-chain verification of an NFT mint lead.
//
// Given a chain + contract (+ optional wallet), it probes a small set of
// common view-function signatures and reports exactly what the contract
// itself answered. Anything the contract does not expose is reported as
// "unverified" — MintCheck never guesses a value.
const { CHAINS } = require('./evm');
const evm = require('./evm');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const OPEN_CANDIDATES = [
  { sig: 'mintOpen()' },
  { sig: 'mintingOpen()' },
  { sig: 'isMintOpen()' },
  { sig: 'publicMintOpen()' },
  { sig: 'mintActive()' },
  { sig: 'isMintActive()' },
  { sig: 'saleActive()' },
  { sig: 'isSaleActive()' },
  { sig: 'publicSaleActive()' },
  { sig: 'saleIsActive()' },
];

const MINTED_COUNT_CANDIDATES = [
  { sig: 'totalSupply()' },
  { sig: 'totalMinted()' },
  { sig: 'mintedCount()' },
  { sig: 'currentSupply()' },
  { sig: 'totalNodes()' },
  { sig: 'supply()' },
];

const MAX_SUPPLY_CANDIDATES = [
  { sig: 'maxSupply()' },
  { sig: 'MAX_SUPPLY()' },
  { sig: 'totalMaxSupply()' },
  { sig: 'collectionSize()' },
];

const PRICE_CANDIDATES = [
  { sig: 'mintPrice()' },
  { sig: 'publicMintPrice()' },
  { sig: 'getMintPrice()' },
  { sig: 'mintCost()' },
  { sig: 'price()' },
  { sig: 'cost()' },
  { sig: 'publicPrice()' },
  { sig: 'salePrice()' },
  { sig: 'mintFee()' },
];

// Price getters that need (wallet, quantity) — tried only with a wallet.
function priceArgCandidates(wallet) {
  return [
    { sig: 'mintCostBNB(address,uint256)', args: [{ type: 'address', value: wallet }, { type: 'uint256', value: 1 }] },
    { sig: 'mintCost(address,uint256)', args: [{ type: 'address', value: wallet }, { type: 'uint256', value: 1 }] },
    { sig: 'mintPrice(address,uint256)', args: [{ type: 'address', value: wallet }, { type: 'uint256', value: 1 }] },
  ];
}

function mintedByCandidates(wallet) {
  const a = [{ type: 'address', value: wallet }];
  return [
    { sig: 'mintedBy(address)', args: a },
    { sig: 'numberMinted(address)', args: a },
    { sig: 'minted(address)', args: a },
    { sig: 'walletMinted(address)', args: a },
    { sig: 'getMinted(address)', args: a },
    { sig: 'mintCount(address)', args: a },
    { sig: 'totalMinted(address)', args: a },
  ];
}

const PER_WALLET_LIMIT_CANDIDATES = [
  { sig: 'maxPerWallet()' },
  { sig: 'MAX_PER_WALLET()' },
  { sig: 'maxMintPerWallet()' },
  { sig: 'perWalletLimit()' },
  { sig: 'mintLimit()' },
];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

async function checkMint({ chain, contract, wallet }) {
  const chainCfg = CHAINS[chain];
  const rpcs = chainCfg.rpcs;
  const verified = [];
  const unverified = [];

  const out = {
    ok: true,
    chain,
    chainLabel: chainCfg.label,
    chainId: chainCfg.chainId,
    contract,
    wallet: wallet || null,
    token: { name: null, symbol: null },
    supply: { minted: null, mintedSource: null, max: null, maxSource: null, remaining: null },
    mint: {
      open: null,
      openSource: null,
      priceWei: null,
      price: null,
      priceSource: null,
      basePriceWei: null,
      basePrice: null,
      basePriceSource: null,
      currency: chainCfg.currency,
    },
    walletInfo: null,
    verdict: null,
    summary: null,
    verifiedChecks: verified,
    unverifiedChecks: unverified,
    checkedAt: new Date().toISOString(),
  };

  // 0. Is there a contract at all?
  const code = await evm.rpcRequest(rpcs, 'eth_getCode', [contract, 'latest']);
  if (!code || code === '0x') {
    out.ok = false;
    out.error = 'NOT_A_CONTRACT';
    out.summary = `No contract code found at ${contract} on ${chainCfg.label}.`;
    return out;
  }
  verified.push('contract code exists (eth_getCode)');

  // 1. Identity + supply (independent calls, run together).
  const [name, symbol, mintedRes, maxSupply] = await Promise.all([
    evm.tryView(rpcs, contract, 'name()', [], 'string'),
    evm.tryView(rpcs, contract, 'symbol()', [], 'string'),
    evm.tryCandidates(rpcs, contract, MINTED_COUNT_CANDIDATES, 'uint'),
    evm.tryCandidates(rpcs, contract, MAX_SUPPLY_CANDIDATES, 'uint'),
  ]);
  out.token.name = name;
  out.token.symbol = symbol;
  if (name !== null) verified.push('name()'); else unverified.push('name()');
  if (mintedRes.value !== null) {
    out.supply.minted = mintedRes.value.toString();
    out.supply.mintedSource = mintedRes.source;
    verified.push(mintedRes.source);
  } else unverified.push('minted count (tried totalSupply/totalMinted/mintedCount/currentSupply/totalNodes/supply)');
  if (maxSupply.value !== null) {
    out.supply.max = maxSupply.value.toString();
    out.supply.maxSource = maxSupply.source;
    verified.push(maxSupply.source);
  } else unverified.push('max supply (tried maxSupply/MAX_SUPPLY/totalMaxSupply/collectionSize)');
  if (out.supply.minted !== null && out.supply.max !== null) {
    const rem = BigInt(out.supply.max) - BigInt(out.supply.minted);
    out.supply.remaining = (rem > 0n ? rem : 0n).toString();
  }
  const soldOut =
    out.supply.minted !== null &&
    out.supply.max !== null &&
    BigInt(out.supply.minted) >= BigInt(out.supply.max);

  // 2–4. Open flag, price, and wallet checks are independent probes —
  // run the groups concurrently, then apply the results in order.
  const [openRes, basePriceRes, walletPriceRes, walletRaw] = await Promise.all([
    evm.tryCandidates(rpcs, contract, OPEN_CANDIDATES, 'bool'),
    evm.tryCandidates(rpcs, contract, PRICE_CANDIDATES, 'uint'),
    wallet
      ? evm.tryCandidates(rpcs, contract, priceArgCandidates(wallet), 'uint')
      : Promise.resolve({ value: null, source: null }),
    wallet
      ? Promise.all([
          evm.tryView(rpcs, contract, 'balanceOf(address)', [{ type: 'address', value: wallet }], 'uint'),
          evm.tryCandidates(rpcs, contract, mintedByCandidates(wallet), 'uint'),
          evm.tryCandidates(rpcs, contract, PER_WALLET_LIMIT_CANDIDATES, 'uint'),
        ])
      : Promise.resolve(null),
  ]);

  // 2. Is minting open?
  if (openRes.value !== null) {
    out.mint.open = openRes.value;
    out.mint.openSource = openRes.source;
    verified.push(openRes.source);
  } else {
    unverified.push('mint-open flag (contract exposes none of the common mintOpen/saleActive getters)');
  }

  // 3. Mint price. No-arg getters give the collection's base price; when a
  // wallet is supplied, (wallet, qty) cost getters give what THAT wallet
  // would actually pay (e.g. a free first mint for eligible wallets) and
  // take precedence as the effective price.
  if (basePriceRes.value !== null) {
    out.mint.basePriceWei = basePriceRes.value.toString();
    out.mint.basePrice = evm.formatNative(basePriceRes.value, chainCfg.currency);
    out.mint.basePriceSource = basePriceRes.source;
    verified.push(basePriceRes.source);
  }
  const effective = walletPriceRes.value !== null ? walletPriceRes : basePriceRes;
  if (effective.value !== null) {
    out.mint.priceWei = effective.value.toString();
    out.mint.price = evm.formatNative(effective.value, chainCfg.currency);
    out.mint.priceSource = effective.source;
    if (walletPriceRes.value !== null) verified.push(walletPriceRes.source);
  } else {
    unverified.push('mint price (no common price getter answered)');
  }

  // 4. Wallet-specific checks.
  if (wallet && walletRaw) {
    const [balance, mintedRes, limitRes] = walletRaw;
    const wi = {
      balance: null,
      mintedByWallet: null,
      mintedSource: null,
      perWalletLimit: null,
      perWalletLimitSource: null,
      remainingAllowance: null,
    };
    if (balance !== null) {
      wi.balance = balance.toString();
      verified.push('balanceOf(address)');
    } else unverified.push('balanceOf(address)');
    if (mintedRes.value !== null) {
      wi.mintedByWallet = mintedRes.value.toString();
      wi.mintedSource = mintedRes.source;
      verified.push(mintedRes.source);
    } else unverified.push('per-wallet minted count (no common mintedBy/numberMinted getter answered)');
    if (limitRes.value !== null) {
      wi.perWalletLimit = limitRes.value.toString();
      wi.perWalletLimitSource = limitRes.source;
      verified.push(limitRes.source);
      if (wi.mintedByWallet !== null) {
        const rem = BigInt(wi.perWalletLimit) - BigInt(wi.mintedByWallet);
        wi.remainingAllowance = (rem > 0n ? rem : 0n).toString();
      }
    }
    out.walletInfo = wi;
  }

  // 5. Verdict — only from values the contract actually returned.
  const priceKnown = out.mint.priceWei !== null;
  const isFree = priceKnown && BigInt(out.mint.priceWei) === 0n;
  if (soldOut) out.verdict = 'SOLD OUT';
  else if (out.mint.open === false) out.verdict = 'CLOSED';
  else if (out.mint.open === true && isFree) out.verdict = 'OPEN & FREE';
  else if (out.mint.open === true && priceKnown) out.verdict = 'OPEN BUT PAID';
  else if (out.mint.open === true) out.verdict = 'OPEN — PRICE UNVERIFIED';
  else if (isFree) out.verdict = 'PRICE FREE — OPEN STATE UNVERIFIED';
  else out.verdict = 'UNKNOWN — INSUFFICIENT ON-CHAIN DATA';

  const bits = [];
  const label = out.token.name ? `${out.token.name}${out.token.symbol ? ` (${out.token.symbol})` : ''}` : contract;
  bits.push(`${label} on ${chainCfg.label}: verdict ${out.verdict}.`);
  if (out.supply.minted !== null) {
    bits.push(
      out.supply.max !== null
        ? `Minted ${out.supply.minted}/${out.supply.max} (${out.supply.remaining} remaining).`
        : `Minted so far: ${out.supply.minted} (max supply not exposed).`
    );
  }
  if (out.mint.open !== null) bits.push(`Mint open flag (${out.mint.openSource}): ${out.mint.open}.`);
  if (priceKnown) {
    bits.push(`Mint price (${out.mint.priceSource}): ${out.mint.price}.`);
    if (
      out.mint.basePriceWei !== null &&
      out.mint.basePriceWei !== out.mint.priceWei
    ) {
      bits.push(`Base price (${out.mint.basePriceSource}) is ${out.mint.basePrice} — the wallet-specific cost above is what this wallet would actually pay.`);
    }
  }
  if (out.walletInfo && out.walletInfo.mintedByWallet !== null) {
    bits.push(`Wallet has minted ${out.walletInfo.mintedByWallet} so far${out.walletInfo.perWalletLimit ? ` of a ${out.walletInfo.perWalletLimit} per-wallet limit` : ''}.`);
  }
  out.summary = bits.join(' ');

  return out;
}

module.exports = { checkMint, ZERO_ADDRESS };
