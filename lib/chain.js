// Everything that touches Mantle: wallets, the DialChecks contract, claim codes, and the ledger feed.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const crypto = require('crypto');
const { ethers } = require('ethers');
const deployments = require('../deployments.json');
const checksAbi = require('../build/DialChecks.json').abi;
const tokenAbi = require('../build/TestAUSD.json').abi;

const EXPLORER = 'https://sepolia.mantlescan.xyz';
const DECIMALS = 6;
const STATUS = ['none', 'open', 'cashed', 'refunded'];

const provider = new ethers.JsonRpcProvider(process.env.MANTLE_RPC, deployments.chainId, { staticNetwork: true });
const deployer = new ethers.Wallet(process.env.DEPLOYER_PK, provider); // also acts as the NGO + gas sponsor
const sender = new ethers.Wallet(process.env.SENDER_PK, provider);
const shopWallet = new ethers.Wallet(process.env.SHOP_PK, provider);
const checks = new ethers.Contract(deployments.checks, checksAbi, provider);
const token = new ethers.Contract(deployments.token, tokenAbi, provider);

const toUnits = usd => ethers.parseUnits(String(usd), DECIMALS);
const fromUnits = units => Number(ethers.formatUnits(units, DECIMALS));
const txUrl = hash => `${EXPLORER}/tx/${hash}`;
const addrUrl = addr => `${EXPLORER}/address/${addr}`;

// Custodial wallet for anyone who receives money, derived from their phone number.
// Receivers never need an app, a seed phrase, or gas.
function walletForPhone(phone) {
  const pk = ethers.keccak256(ethers.toUtf8Bytes(`${process.env.WALLET_SEED}:${phone}`));
  return new ethers.Wallet(pk, provider);
}

// Claim secret (32 bytes, revealed on-chain only when cashing) and the 6-digit code
// the receiver reads to the shop. Both are re-derived from the check's public `ref`,
// so the server stores nothing.
const hmac = (label, ref) => crypto.createHmac('sha256', process.env.CODE_SECRET).update(`${label}:${ref}`).digest();
const claimSecretFor = ref => '0x' + hmac('claim', ref).toString('hex');
const codeFor = ref => String(hmac('code', ref).readUInt32BE(0) % 1_000_000).padStart(6, '0');

function newClaim() {
  const ref = ethers.hexlify(ethers.randomBytes(32));
  const secret = claimSecretFor(ref);
  return { ref, claimHash: ethers.keccak256(secret), code: codeFor(ref) };
}

async function createCheck({ phone, amountUsd, ttlSeconds = 7 * 24 * 3600 }) {
  const receiver = walletForPhone(phone).address;
  const claim = newClaim();
  const tx = await checks.connect(sender).createCheck(receiver, toUnits(amountUsd), ttlSeconds, claim.ref, claim.claimHash);
  const rcpt = await tx.wait();
  const ev = rcpt.logs.map(l => { try { return checks.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'CheckCreated');
  return { id: Number(ev.args.id), receiver, code: claim.code, txHash: tx.hash, txUrl: txUrl(tx.hash) };
}

async function createChecksBulk(rows, ttlSeconds) {
  const receivers = [], amounts = [], refs = [], hashes = [], codes = [];
  for (const r of rows) {
    const c = newClaim();
    receivers.push(walletForPhone(r.phone).address);
    amounts.push(toUnits(r.amount));
    refs.push(c.ref);
    hashes.push(c.claimHash);
    codes.push(c.code);
  }
  const tx = await checks.connect(deployer).createChecks(receivers, amounts, ttlSeconds, refs, hashes);
  const rcpt = await tx.wait();
  const ids = rcpt.logs
    .map(l => { try { return checks.interface.parseLog(l); } catch { return null; } })
    .filter(e => e?.name === 'CheckCreated')
    .map(e => Number(e.args.id));
  return { ids, codes, txHash: tx.hash, txUrl: txUrl(tx.hash), gasUsed: rcpt.gasUsed.toString() };
}

// The public testnet RPC rate-limits bursts, so reads retry with a short backoff.
async function retry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
}

// Cashed and refunded checks never change again, so they're cached.
const finalChecks = new Map();
async function readCheck(id) {
  if (finalChecks.has(Number(id))) return finalChecks.get(Number(id));
  const c = await retry(() => checks.checks(id));
  const out = {
    id: Number(id),
    sender: c.sender,
    receiver: c.receiver,
    amountUsd: fromUnits(c.amount),
    expiresAt: Number(c.expiresAt),
    status: STATUS[Number(c.status)],
    ref: c.ref,
  };
  if (out.status === 'cashed' || out.status === 'refunded') finalChecks.set(out.id, out);
  return out;
}

// Read many checks a few at a time instead of all at once.
async function readChecks(ids, batch = 4) {
  const out = [];
  for (let i = 0; i < ids.length; i += batch) {
    out.push(...(await Promise.all(ids.slice(i, i + batch).map(readCheck))));
  }
  return out;
}

// Chunked log query (RPCs cap the block range per request).
async function getLogs(filter, fromBlock) {
  const latest = await retry(() => provider.getBlockNumber());
  const start = Math.max(fromBlock ?? deployments.deployBlock, deployments.deployBlock);
  const step = 9_000;
  const out = [];
  for (let b = start; b <= latest; b += step + 1) {
    out.push(...(await retry(() => checks.queryFilter(filter, b, Math.min(b + step, latest)))));
  }
  return out;
}

async function checksForPhone(phone) {
  const receiver = walletForPhone(phone).address;
  const logs = await getLogs(checks.filters.CheckCreated(null, null, receiver));
  const list = await readChecks(logs.map(l => l.args.id));
  return list.map((c, i) => ({ ...c, createdTx: logs[i].transactionHash, createdBlock: logs[i].blockNumber }));
}

async function checksBySender(addr) {
  const logs = await getLogs(checks.filters.CheckCreated(null, addr));
  const list = await readChecks(logs.map(l => l.args.id));
  return list.map((c, i) => ({ ...c, createdTx: logs[i].transactionHash }));
}

const blockTimes = new Map();
async function blockTime(n) {
  if (!blockTimes.has(n)) blockTimes.set(n, (await retry(() => provider.getBlock(n))).timestamp);
  return blockTimes.get(n);
}

// Gas sponsorship: top up a custodial wallet so it can sign its own cash-out.
async function ensureGas(wallet, min = ethers.parseEther('0.05')) {
  const bal = await provider.getBalance(wallet.address);
  if (bal < min) await (await deployer.sendTransaction({ to: wallet.address, value: min * 2n })).wait();
}

async function cashOut({ phone, code, payTo }) {
  const wallet = walletForPhone(phone);
  const now = Math.floor(Date.now() / 1000);
  const open = (await checksForPhone(phone)).filter(c => c.status === 'open' && c.expiresAt > now);
  const match = open.find(c => codeFor(c.ref) === String(code).replace(/\D/g, ''));
  if (!match) return { ok: false, error: open.length ? 'That code does not match any open transfer.' : 'There is no open transfer for this phone number.' };
  await ensureGas(wallet);
  const tx = await checks.connect(wallet).cashCheck(match.id, claimSecretFor(match.ref), payTo);
  await tx.wait();
  return { ok: true, id: match.id, amountUsd: match.amountUsd, txHash: tx.hash, txUrl: txUrl(tx.hash) };
}

// The agent's background job: return every expired, unclaimed check to its sender.
async function refundExpired() {
  const now = Math.floor(Date.now() / 1000);
  const logs = await getLogs(checks.filters.CheckCreated());
  const refunded = [];
  for (const l of logs) {
    const c = await readCheck(l.args.id);
    if (c.status === 'open' && c.expiresAt <= now) {
      const tx = await checks.connect(deployer).refund(c.id);
      await tx.wait();
      refunded.push({ id: c.id, amountUsd: c.amountUsd, txHash: tx.hash, txUrl: txUrl(tx.hash) });
    }
  }
  return refunded;
}

// Live ledger feed for the demo screen.
async function feed(limit = 25) {
  const latest = await provider.getBlockNumber();
  const from = Math.max(deployments.deployBlock, latest - 50_000);
  const logs = await getLogs('*', from);
  const items = [];
  for (const l of logs) {
    const e = l.fragment ? { name: l.fragment.name, args: l.args } : checks.interface.parseLog(l);
    if (!e) continue;
    const a = e.args;
    const base = { type: e.name, id: Number(a.id), amountUsd: fromUnits(a.amount), block: l.blockNumber, txHash: l.transactionHash, txUrl: txUrl(l.transactionHash) };
    if (e.name === 'CheckCreated') items.push({ ...base, from: a.sender, to: a.receiver, expiresAt: Number(a.expiresAt) });
    if (e.name === 'CheckCashed') items.push({ ...base, from: a.receiver, to: a.paidTo });
    if (e.name === 'CheckRefunded') items.push({ ...base, to: a.sender });
  }
  return items.sort((x, y) => y.block - x.block).slice(0, limit);
}

async function balances() {
  const [s, shop, ngo] = await Promise.all([
    token.balanceOf(sender.address),
    token.balanceOf(shopWallet.address),
    token.balanceOf(deployer.address),
  ]);
  return { sender: fromUnits(s), shop: fromUnits(shop), ngo: fromUnits(ngo) };
}

module.exports = {
  deployments, provider, sender, shopWallet, deployer, EXPLORER,
  txUrl, addrUrl, walletForPhone, codeFor,
  createCheck, createChecksBulk, readCheck, checksForPhone, checksBySender, blockTime, cashOut, refundExpired, feed, balances,
};
