// Shared helpers for the Dial-a-Dollar pages.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = a => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const usd = n => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({ ok: false, error: `Server error (${res.status})` }));
  if (!res.ok && data.ok !== false) data.ok = false;
  return data;
}

async function busy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Waiting for the blockchain…';
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = label; }
}
