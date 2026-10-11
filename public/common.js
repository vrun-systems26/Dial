// Shared helpers for the Dial pages.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = a => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const usd = n => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

// This browser's private id. Nothing about you is shared with other visitors.
function deviceId() {
  let id = '';
  try { id = localStorage.getItem('dial-device') || ''; } catch {}
  if (!/^[a-f0-9]{32}$/.test(id)) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('dial-device', id); } catch {}
  }
  return id;
}

async function api(path, body) {
  try {
    const headers = { 'x-dial-device': deviceId() };
    if (body) headers['content-type'] = 'application/json';
    const res = await fetch(path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
    const data = await res.json().catch(() => ({ ok: false, error: `Server error (${res.status})` }));
    if (!res.ok && data.ok !== false) data.ok = false;
    return data;
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
  }
}

// Hand-built icons (one family, stroke-only, aria-hidden).
const ICON = {
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
  hangup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 11v6M12 7.5v.01"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
};

// Button states: loading while working, a brief error state on failure, silent on success.
async function busy(btn, fn, label = 'Waiting for the blockchain…') {
  const original = btn.textContent;
  btn.disabled = true;
  btn.dataset.state = 'loading';
  btn.setAttribute('aria-busy', 'true');
  btn.textContent = label;
  let out;
  try { out = await fn(); return out; } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.textContent = original;
    if (out && out.ok === false) {
      btn.dataset.state = 'error';
      setTimeout(() => { if (btn.dataset.state === 'error') delete btn.dataset.state; }, 1800);
    } else delete btn.dataset.state;
  }
}

// Only touch the DOM when content actually changes (keeps polling flicker-free).
const lastHtml = {};
function render(sel, html) {
  if (lastHtml[sel] === html) return;
  lastHtml[sel] = html;
  $(sel).innerHTML = html;
}

// Config + this visitor's private session (their own wallet is labelled with their name).
let configPromise;
const config = () => (configPromise ||= api('/api/config').then(c => {
  c.names = c.names || {};
  // Set up this visitor's private wallet in the background (first visit takes a few seconds).
  api('/api/session', {}).then(s => { if (s.ok) { c.names[s.address] = '@sender'; c.myAddress = s.address; } });
  return c;
}));
// Settings the user picks on the Call page (kept in this browser): names, the receiver's
// phone number and how long they have to collect. Defaults: blank names, a private demo number, 7 days.
// A private demo phone number for this browser, so its texts and codes are only yours.
function demoPhone() {
  let p = '';
  try { p = localStorage.getItem('dial-demo-phone') || ''; } catch {}
  if (!p) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 100000000;
    p = '+5233' + String(n).padStart(8, '0');
    try { localStorage.setItem('dial-demo-phone', p); } catch {}
  }
  return p;
}
const DEMO_PHONE = demoPhone();
const DEFAULT_NAMES = { sender: '', recipient: '', phone: '', expiry: '10080', shop: '' };
// What to show when a name is blank.
const senderDisplay = () => getNames().sender || 'Sender';
const recipientDisplay = () => getNames().recipient || 'Receiver';
const shopDisplay = () => getNames().shop || 'Partner shop';
// What the voice agent calls you ("Hi there" until you set a name).
const senderLabel = () => getNames().sender || 'Someone';
const spokenName = () => getNames().sender || 'there';
const receiverPhone = () => getNames().phone || DEMO_PHONE;
// The receiver's private link (with its secret key) comes from the server after a PIN check.
function receiverLinkFor(phone) {
  const link = getNames().link || '';
  try { const u = new URL(link); return u.searchParams.get('n') === phone ? link : ''; } catch { return ''; }
}
const receiverKey = phone => { try { return new URL(receiverLinkFor(phone)).searchParams.get('k') || ''; } catch { return ''; } };
async function refreshReceiverLink(pin) {
  const n = getNames();
  const d = await api('/api/receiver-link', { phone: receiverPhone(), pin, from: senderLabel() });
  if (d.ok) { const u = new URL(d.link); setNames({ ...getNames(), link: location.origin + u.pathname + u.search }); }
  return d;
}
function untilWords(ts) {
  const s = ts - Math.floor(Date.now() / 1000);
  if (s <= 0) return 'expired';
  if (s < 60) return `${s}s left`;
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
  if (s < 86400) return `${Math.round(s / 3600)} h left`;
  return `${Math.round(s / 86400)} days left`;
}
function getNames() {
  try { return { ...DEFAULT_NAMES, ...JSON.parse(localStorage.getItem('dial-names') || '{}') }; } catch { return { ...DEFAULT_NAMES }; }
}
function setNames(n) {
  try { localStorage.setItem('dial-names', JSON.stringify(n)); } catch {}
  applyNames();
}
// Fill every element marked data-name="sender" / "recipient" with the chosen names.
function applyNames() {
  const n = getNames();
  const shown = { sender: senderDisplay(), recipient: recipientDisplay(), shop: shopDisplay() };
  document.querySelectorAll('[data-name]').forEach(el => { el.textContent = shown[el.dataset.name] || el.textContent; });
}
document.addEventListener('DOMContentLoaded', applyNames);

const nameOf = (cfg, addr) => {
  const v = cfg.names?.[addr];
  if (v === '@sender') return senderDisplay();
  if (v === '@recipient') return recipientDisplay();
  if (v === '@shop') return shopDisplay();
  return v || short(addr);
};

function errorBox(msg) { return `<div class="err"><b>That didn't work</b><span>${esc(msg)}</span></div>`; }
function txLink(url, text = 'View on Mantlescan ↗') { return url ? `<a class="hash" href="${url}" target="_blank" rel="noopener">${text}</a>` : ''; }

// The receiver's texts: one bubble per open transfer, newest first, each with its own code.
function textsHtml(messages, from) {
  const open = messages.filter(m => m.status === 'open' && m.expiresAt > Date.now() / 1000);
  if (!open.length) return '<p class="empty">No new texts. When money is sent to this number, the code shows up here.</p>';
  if (open.some(m => !m.code)) return `<p class="empty">${open.length} transfer${open.length > 1 ? 's are' : ' is'} waiting for this number. Open the private link from the text message to see the code.</p>`;
  return open.map((m, i) => `
    <div class="text-msg${i ? ' older' : ''}">
      <div class="split" style="justify-content:space-between"><span class="label">Transfer #${m.id}</span><span class="countdown" data-exp="${m.expiresAt}">${untilWords(m.expiresAt)}</span></div>
      <div class="sms">${esc(from)} te envió <b>${usd(m.amountUsd)} USD</b>. Cóbralo en cualquier tienda Dial con este código.</div>
      <div class="code">${m.code}</div>
    </div>`).join('');
}

// Live countdowns on anything marked data-exp="<unix seconds>".
setInterval(() => {
  document.querySelectorAll('[data-exp]').forEach(el => {
    const w = untilWords(Number(el.dataset.exp));
    el.textContent = w;
    el.classList.toggle('late', w === 'expired');
  });
}, 1000);
