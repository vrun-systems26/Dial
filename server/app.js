// Dial API: voice-agent tools, cash-out, bulk payouts, refunds and the live ledger feed.
const path = require('path');
const express = require('express');
const chain = require('../lib/chain');
const { senders, shops, findRecipient } = require('../lib/directory');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.shortMessage || err.message });
});

// Voice-agent tools are protected by a shared secret set on the ElevenLabs tool.
function toolAuth(req, res, next) {
  const key = req.get('x-tool-secret') || req.query.key;
  if (key !== process.env.TOOL_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

const MIN_USD = 1;
const MAX_USD = 500;
const carlos = senders.carlos;

async function sendMoney({ recipient, amount_usd, pin }) {
  const r = findRecipient(recipient);
  if (!r) return { ok: false, message: `I couldn't find "${recipient}" in your contacts. Your saved contact is María López (your mom).` };
  const amount = Number(String(amount_usd).replace(/[^0-9.]/g, ''));
  if (!(amount >= MIN_USD && amount <= MAX_USD)) return { ok: false, message: `The amount must be between $${MIN_USD} and $${MAX_USD}.` };
  if (String(pin).replace(/\D/g, '') !== carlos.pin) return { ok: false, message: 'That PIN is not correct. Nothing was sent.' };
  const c = await chain.createCheck({ phone: r.phone, amountUsd: amount });
  return {
    ok: true,
    message: `Sent. $${amount} is locked for ${r.name} on the Mantle blockchain. She will get a text with a 6-digit code and can collect cash at any partner shop within 7 days. If she doesn't, the money comes back to you automatically.`,
    check_id: c.id,
    recipient: r.name,
    amount_usd: amount,
    fee_usd: 0,
    tx_url: c.txUrl,
  };
}

async function checkStatus({ recipient }) {
  const r = findRecipient(recipient) || findRecipient('maria');
  const list = await chain.checksForPhone(r.phone);
  if (!list.length) return { ok: true, message: `You haven't sent anything to ${r.name} yet.` };
  const last = list[list.length - 1];
  const words = {
    open: `is waiting for her to collect. It expires ${new Date(last.expiresAt * 1000).toUTCString()}.`,
    cashed: 'has been collected. She picked it up at Abarrotes Lupita.',
    refunded: 'was never collected, so it was refunded to you.',
  };
  return { ok: true, message: `Your latest transfer of $${last.amountUsd} to ${r.name} ${words[last.status]}`, status: last.status, check_id: last.id };
}

// ---- Voice agent tools (called by ElevenLabs) ----
app.post('/api/tools/send_money', toolAuth, wrap(async (req, res) => res.json(await sendMoney(req.body || {}))));
app.post('/api/tools/check_status', toolAuth, wrap(async (req, res) => res.json(await checkStatus(req.body || {}))));

// Same as the voice tool, for the on-screen backup button and testing.
app.post('/api/send', wrap(async (req, res) => res.json(await sendMoney(req.body || {}))));
app.get('/api/status', wrap(async (req, res) => res.json(await checkStatus({ recipient: req.query.recipient || 'maria' }))));

// ---- Receiver side ----
// Simulated SMS inbox: in production this text is sent by SMS (e.g. Twilio).
app.get('/api/inbox', wrap(async (req, res) => {
  const phone = req.query.phone;
  const list = await chain.checksForPhone(phone);
  const messages = list.map(c => ({
    id: c.id,
    amountUsd: c.amountUsd,
    status: c.status,
    expiresAt: c.expiresAt,
    code: c.status === 'open' ? chain.codeFor(c.ref) : null,
    txUrl: chain.txUrl(c.createdTx),
  }));
  res.json({ ok: true, phone, messages: messages.reverse() });
}));

// Shop cash-out. Simple per-phone attempt limit so codes can't be guessed.
const attempts = new Map();
app.post('/api/cashout', wrap(async (req, res) => {
  const { phone, code, shopId = 'lupita' } = req.body || {};
  const shop = shops[shopId];
  if (!shop) return res.status(400).json({ ok: false, error: 'Unknown shop.' });
  const a = attempts.get(phone) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60_000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 5) return res.status(429).json({ ok: false, error: 'Too many wrong codes. Try again in 15 minutes.' });
  const out = await chain.cashOut({ phone, code, payTo: chain.shopWallet.address });
  if (!out.ok) { a.n++; attempts.set(phone, a); return res.json(out); }
  attempts.delete(phone);
  res.json({ ...out, shop: shop.name, payoutLocal: Math.round(out.amountUsd * shop.rate), currency: shop.currency });
}));

// ---- Autonomous refunds (also run on a schedule) ----
app.all('/api/keeper', wrap(async (req, res) => res.json({ ok: true, refunded: await chain.refundExpired() })));

// ---- NGO bulk payouts ----
app.post('/api/bulk', wrap(async (req, res) => {
  const rows = (req.body?.rows || []).filter(r => r.phone && Number(r.amount) > 0);
  if (!rows.length || rows.length > 100) return res.status(400).json({ ok: false, error: 'Send between 1 and 100 rows of phone + amount.' });
  const ttl = Math.max(60, Number(req.body.ttlMinutes || 7 * 24 * 60) * 60);
  const out = await chain.createChecksBulk(rows, ttl);
  res.json({ ok: true, ...out, count: rows.length, totalUsd: rows.reduce((s, r) => s + Number(r.amount), 0) });
}));

// ---- Income passport: verified history of money received ----
app.get('/api/passport', wrap(async (req, res) => {
  const list = await chain.checksForPhone(req.query.phone);
  const received = list.filter(c => c.status === 'cashed');
  res.json({
    ok: true,
    phone: req.query.phone,
    wallet: chain.walletForPhone(req.query.phone).address,
    walletUrl: chain.addrUrl(chain.walletForPhone(req.query.phone).address),
    transfersReceived: received.length,
    totalUsd: received.reduce((s, c) => s + c.amountUsd, 0),
    items: list.map(c => ({ id: c.id, amountUsd: c.amountUsd, status: c.status, txUrl: chain.txUrl(c.createdTx) })),
  });
}));

// ---- Demo screen data ----
app.get('/api/feed', wrap(async (req, res) => res.json({ ok: true, items: await chain.feed() })));
app.get('/api/balances', wrap(async (req, res) => res.json({ ok: true, ...(await chain.balances()) })));
app.get('/api/config', (req, res) => res.json({
  agentId: process.env.ELEVENLABS_AGENT_ID || null,
  explorer: chain.EXPLORER,
  contracts: { checks: chain.deployments.checks, token: chain.deployments.token },
  checksUrl: chain.addrUrl(chain.deployments.checks),
  sender: { name: carlos.name, city: carlos.city, phone: carlos.phone },
  receiver: { name: 'María López', city: 'Guadalajara, MX', phone: '+523312345678' },
  shop: { id: 'lupita', ...shops.lupita },
  names: {
    [chain.sender.address]: 'Carlos',
    [chain.walletForPhone('+523312345678').address]: 'María López',
    [chain.shopWallet.address]: 'Abarrotes Lupita',
    [chain.deployer.address]: 'Relief Fund',
  },
}));

module.exports = app;
