// Shared helpers for the Dial pages.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = a => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const usd = n => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

async function api(path, body) {
  try {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await res.json().catch(() => ({ ok: false, error: `Server error (${res.status})` }));
    if (!res.ok && data.ok !== false) data.ok = false;
    return data;
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
  }
}

async function busy(btn, fn, label = 'Waiting for the blockchain…') {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = original; }
}

// Only touch the DOM when content actually changes (keeps polling flicker-free).
const lastHtml = {};
function render(sel, html) {
  if (lastHtml[sel] === html) return;
  lastHtml[sel] = html;
  $(sel).innerHTML = html;
}

let configPromise;
const config = () => (configPromise ||= api('/api/config'));
// Settings the user picks on the Call page (kept in this browser): names, the receiver's
// phone number and how long they have to collect. Defaults: Varun → Relative, demo number, 7 days.
const DEMO_PHONE = '+523312345678';
const DEFAULT_NAMES = { sender: 'Varun', recipient: 'Relative', phone: '', expiry: '10080', shop: 'Corner Shop' };
const receiverPhone = () => getNames().phone || DEMO_PHONE;
const phoneLink = phone => `${location.origin}/phone.html?n=${encodeURIComponent(phone)}&from=${encodeURIComponent(getNames().sender)}`;
function untilWords(ts) {
  const s = ts - Math.floor(Date.now() / 1000);
  if (s <= 0) return 'expired';
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
  document.querySelectorAll('[data-name]').forEach(el => { el.textContent = n[el.dataset.name] || el.textContent; });
}
document.addEventListener('DOMContentLoaded', applyNames);

const nameOf = (cfg, addr) => {
  const v = cfg.names?.[addr];
  if (v === '@sender') return getNames().sender;
  if (v === '@recipient') return getNames().recipient;
  if (v === '@shop') return getNames().shop;
  return v || short(addr);
};

function errorBox(msg) { return `<div class="err"><b>That didn't work</b><span>${esc(msg)}</span></div>`; }
function txLink(url, text = 'View on Mantlescan ↗') { return url ? `<a class="hash" href="${url}" target="_blank" rel="noopener">${text}</a>` : ''; }

// The receiver's texts: one bubble per open transfer, newest first, each with its own code.
function textsHtml(messages, from) {
  const open = messages.filter(m => m.status === 'open' && m.expiresAt > Date.now() / 1000);
  if (!open.length) return '<p class="empty">No new texts. When money is sent to this number, the code shows up here.</p>';
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
