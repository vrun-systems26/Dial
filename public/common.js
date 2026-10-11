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
const nameOf = (cfg, addr) => cfg.names?.[addr] || short(addr);

function errorBox(msg) { return `<div class="err"><b>That didn't work</b><span>${esc(msg)}</span></div>`; }
function txLink(url, text = 'View on Mantlescan ↗') { return url ? `<a class="hash" href="${url}" target="_blank" rel="noopener">${text}</a>` : ''; }
