// Dial API: voice-agent tools, cash-out, bulk payouts, refunds and the live ledger feed.
const path = require('path');
const express = require('express');
const chain = require('../lib/chain');
const { senders, shops, findRecipient } = require('../lib/directory');
const sms = require('../lib/sms');
const { sendSms } = sms;

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
const DEFAULT_TTL = 7 * 24 * 3600;
const DUPLICATE_WINDOW = 120; // seconds
const caller = senders.varun;
const SITE = process.env.SITE_URL || 'https://dial-a-dollar.vercel.app';

// Whatever the caller calls their contact ("mom", "my friend") is used when talking back.
const labelFor = (said, r) => (String(said || '').trim() ? String(said).trim() : r.name);

// Any phone number gets its own custodial wallet, so Dial works for numbers it has never seen.
function normalizePhone(p) {
  const raw = String(p || '').trim();
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (!raw.startsWith('+') && digits.length === 10) digits = '1' + digits; // US number without country code
  return digits.length >= 8 && digits.length <= 15 ? '+' + digits : null;
}

// The receiver's private link: their texts and codes, protected by a secret key.
const receiverLink = (phone, from) => `${SITE}/phone.html?n=${encodeURIComponent(phone)}&k=${chain.linkKey(phone)}&from=${encodeURIComponent(from)}`;

// How long the receiver has to collect: 15 seconds (for live demos) up to 30 days.
function ttlFrom(minutes) {
  const m = Number(minutes);
  return m > 0 ? Math.min(Math.max(Math.round(m * 60), 10), 30 * 24 * 3600) : DEFAULT_TTL;
}
function windowWords(ttl) {
  if (ttl < 60) return `${ttl} seconds`;
  if (ttl % 86400 === 0) return `${ttl / 86400} day${ttl === 86400 ? '' : 's'}`;
  if (ttl % 3600 === 0) return `${ttl / 3600} hour${ttl === 3600 ? '' : 's'}`;
  return `${Math.round(ttl / 60)} minute${ttl === 60 ? '' : 's'}`;
}

async function sendMoney({ recipient, amount_usd, pin, recipient_phone, expiry_minutes, sender_name }) {
  const r = findRecipient(recipient);
  const label = labelFor(recipient, r);
  const phone = normalizePhone(recipient_phone) || r.phone;
  const ttl = ttlFrom(expiry_minutes);
  const amount = Math.round(Number(String(amount_usd).replace(/[^0-9.]/g, '')) * 100) / 100;
  if (!(amount >= MIN_USD && amount <= MAX_USD)) return { ok: false, message: `The amount must be between $${MIN_USD} and $${MAX_USD}. Nothing was sent.` };
  if (String(pin).replace(/\D/g, '') !== caller.pin) return { ok: false, message: 'That PIN is not correct. Nothing was sent.' };

  // Safety net: if the same amount was just sent to the same person (e.g. the call was
  // interrupted and the agent retried), return that transfer instead of sending twice.
  const now = Math.floor(Date.now() / 1000);
  const recent = (await chain.checksForPhone(phone)).reverse().find(c => c.status === 'open' && c.amountUsd === amount);
  if (recent && now - (await chain.blockTime(recent.createdBlock)) < DUPLICATE_WINDOW) {
    return { ok: true, duplicate: true, message: `That transfer already went through. $${amount} is locked for ${label}. Nothing extra was sent.`, check_id: recent.id, recipient: label, amount_usd: amount, fee_usd: 0, tx_url: chain.txUrl(recent.createdTx) };
  }

  const c = await chain.createCheck({ phone, amountUsd: amount, ttlSeconds: ttl });
  const from = String(sender_name || caller.name).slice(0, 40);
  const sms = await sendSms(phone, `${from} sent you $${amount.toFixed(2)} with Dial. Your code: ${c.code}. Collect cash at any Dial shop within ${windowWords(ttl)}. ${receiverLink(phone, from)}`).catch(e => ({ sent: false, reason: e.message }));
  return {
    ok: true,
    message: `Sent. $${amount.toFixed(2)} is locked for ${label} on the blockchain. ${sms.sent ? 'A text with their 6-digit code is on its way.' : 'They get a 6-digit code.'} They can collect cash at any partner shop within ${windowWords(ttl)}. If they don't, the money comes back automatically.`,
    check_id: c.id,
    recipient: label,
    amount_usd: amount,
    fee_usd: 0,
    collect_within: windowWords(ttl),
    receiver_link: receiverLink(phone, from),
    text_sent: sms.sent,
    tx_url: c.txUrl,
  };
}

async function checkStatus({ recipient, recipient_phone }) {
  const r = findRecipient(recipient);
  const label = labelFor(recipient, r);
  const list = await chain.checksForPhone(normalizePhone(recipient_phone) || r.phone);
  if (!list.length) return { ok: true, message: `You haven't sent anything to ${label} yet.` };
  const last = list[list.length - 1];
  const words = {
    open: `is waiting to be collected. It expires ${new Date(last.expiresAt * 1000).toUTCString()}.`,
    cashed: 'has been collected as cash at a partner shop.',
    refunded: 'was never collected, so it was refunded to you.',
  };
  return { ok: true, message: `Your latest transfer of $${last.amountUsd} to ${label} ${words[last.status]}`, status: last.status, check_id: last.id };
}

// ---- Voice agent tools (called by ElevenLabs) ----
app.post('/api/tools/send_money', toolAuth, wrap(async (req, res) => res.json(await sendMoney(req.body || {}))));
app.post('/api/tools/check_status', toolAuth, wrap(async (req, res) => res.json(await checkStatus(req.body || {}))));

// Same as the voice tool, for the on-screen backup button and testing.
app.post('/api/send', wrap(async (req, res) => res.json(await sendMoney(req.body || {}))));
app.get('/api/status', wrap(async (req, res) => res.json(await checkStatus({ recipient: req.query.recipient || 'Relative', recipient_phone: req.query.phone }))));

// ---- Receiver side ----
// Simulated SMS inbox: in production this text is sent by SMS (e.g. Twilio).
app.get('/api/inbox', wrap(async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'Enter a phone number with country code, like +1 555 123 4567.' });
  const unlocked = chain.linkKeyOk(phone, req.query.k);
  const list = await chain.checksForPhone(phone);
  const messages = list.map(c => ({
    id: c.id,
    amountUsd: c.amountUsd,
    status: c.status,
    expiresAt: c.expiresAt,
    code: c.status === 'open' && unlocked ? chain.codeFor(c.ref) : null,
    txUrl: chain.txUrl(c.createdTx),
  }));
  res.json({ ok: true, phone, unlocked, messages: messages.reverse() });
}));

// Shop cash-out. Simple per-phone attempt limit so codes can't be guessed.
const attempts = new Map();
app.post('/api/cashout', wrap(async (req, res) => {
  const { code, shopId = 'lupita' } = req.body || {};
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'Enter the customer phone number with country code.' });
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
  if (String(req.body?.pin || '').replace(/\D/g, '') !== caller.pin) return res.status(401).json({ ok: false, error: 'Enter the organization PIN to send payouts.' });
  const rows = (req.body?.rows || []).map(r => ({ phone: normalizePhone(r.phone), amount: Number(r.amount) })).filter(r => r.phone && r.amount > 0);
  if (!rows.length || rows.length > 100) return res.status(400).json({ ok: false, error: 'Send between 1 and 100 rows of phone + amount.' });
  const ttl = ttlFrom(req.body.ttlMinutes || 7 * 24 * 60);
  const out = await chain.createChecksBulk(rows, ttl);
  // Each family gets their own text (when SMS is switched on).
  const org = String(req.body.org || 'Relief Fund').slice(0, 40);
  const texts = await Promise.all(rows.map((r, i) => sendSms(r.phone, `${org} sent you $${r.amount.toFixed(2)} with Dial. Your code: ${out.codes[i]}. Collect cash at any Dial shop within ${windowWords(ttl)}. ${receiverLink(r.phone, org)}`).catch(() => ({ sent: false }))));
  res.json({ ok: true, ...out, phones: rows.map(r => r.phone), links: rows.map(r => receiverLink(r.phone, org)), count: rows.length, totalUsd: rows.reduce((s, r) => s + r.amount, 0), textsSent: texts.filter(t => t.sent).length });
}));

// ---- Donor report: where every NGO dollar went ----
app.get('/api/ngo/report', wrap(async (req, res) => {
  const list = await chain.checksBySender(chain.deployer.address);
  const now = Math.floor(Date.now() / 1000);
  const sum = f => list.filter(f).reduce((s, c) => s + c.amountUsd, 0);
  res.json({
    ok: true,
    families: list.length,
    sentUsd: sum(() => true),
    collectedUsd: sum(c => c.status === 'cashed'),
    waitingUsd: sum(c => c.status === 'open' && c.expiresAt > now),
    expiredUsd: sum(c => c.status === 'open' && c.expiresAt <= now),
    returnedUsd: sum(c => c.status === 'refunded'),
    counts: { collected: list.filter(c => c.status === 'cashed').length, waiting: list.filter(c => c.status === 'open').length, returned: list.filter(c => c.status === 'refunded').length },
    contractUrl: chain.addrUrl(chain.deployments.checks),
  });
}));

// ---- Income passport: verified history of money received ----
app.get('/api/passport', wrap(async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'Enter a phone number with country code.' });
  req.query.phone = phone;
  const list = await chain.checksForPhone(phone);
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

// The sender (who knows the PIN) can get the receiver's private link to share.
app.post('/api/receiver-link', wrap(async (req, res) => {
  const phone = normalizePhone(req.body?.phone) || findRecipient().phone;
  if (String(req.body?.pin || '').replace(/\D/g, '') !== caller.pin) return res.status(401).json({ ok: false, error: 'Wrong PIN.' });
  res.json({ ok: true, phone, link: receiverLink(phone, String(req.body?.from || caller.name).slice(0, 40)) });
}));

// Which wallet belongs to a phone number (so the ledger can show the user's chosen name).
app.get('/api/whois', (req, res) => {
  const phone = normalizePhone(req.query.phone);
  res.json(phone ? { ok: true, phone, address: chain.walletForPhone(phone).address } : { ok: false, error: 'bad phone' });
});

// ---- Demo screen data ----
app.get('/api/feed', wrap(async (req, res) => res.json({ ok: true, items: await chain.feed() })));
app.get('/api/balances', wrap(async (req, res) => res.json({ ok: true, ...(await chain.balances()) })));
app.get('/api/config', (req, res) => res.json({
  agentId: process.env.ELEVENLABS_AGENT_ID || null,
  explorer: chain.EXPLORER,
  contracts: { checks: chain.deployments.checks, token: chain.deployments.token },
  checksUrl: chain.addrUrl(chain.deployments.checks),
  sender: { name: caller.name, phone: caller.phone },
  receiver: { name: 'Relative', city: 'Guadalajara, MX', phone: '+523312345678' },
  shop: { id: 'lupita', ...shops.lupita },
  smsEnabled: sms.enabled(),
  names: {
    [chain.sender.address]: '@sender',
    [chain.walletForPhone('+523312345678').address]: '@recipient',
    [chain.shopWallet.address]: '@shop',
    [chain.deployer.address]: 'Relief Fund',
  },
}));

module.exports = app;
