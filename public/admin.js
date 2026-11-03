'use strict';
const B = window.BASE, $ = id => document.getElementById(id);
let data = { channels: [], categories: [] };
async function api(p, body) {
  const o = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(B + p, o);
  if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw 0; }
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const msg = t => { $('info').textContent = t; };

async function status() {
  const s = await api('/api/status');
  $('active').innerHTML = s.channels.map(c => `<div class="card"><span class="n">${esc(c.name)}</span>
   <span class="dim">${c.viewers ? '👁 ' + c.viewers : ''}</span><span class="st ${c.status}">${c.status}${c.retryIn ? ' ' + c.retryIn + 's' : ''}</span>
   ${c.status === 'down' ? `<button data-sel="${c.id}">↻</button>` : ''}<button data-stop="${c.id}">✕</button></div>`).join('');
}
function render() {
  const q = $('q').value.trim().toLowerCase(), cat = $('cat').value;
  const m = data.channels.filter(c => (!cat || c.cat === cat) && (!q || c.name.toLowerCase().includes(q)));
  $('list').innerHTML = m.slice(0, 200).map(c => `<div class="card" data-sel="${c.id}">${c.icon ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(c.icon)}" onerror="this.remove()">` : ''}<span class="n">${esc(c.name)}</span></div>`).join('')
    + (m.length > 200 ? `<div class="dim">+${m.length - 200}</div>` : '');
}
async function load() {
  try { data = await api('/api/channels'); } catch (e) { return msg(e.message); }
  const cats = data.categories.slice().sort((a, b) => a.name.localeCompare(b.name));
  $('cat').innerHTML = '<option value="">All</option>' + cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  msg(`${data.channels.length} · ${new Date(data.fetchedAt).toLocaleString()}`); render();
}
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-sel],[data-stop]'); if (!t) return;
  try {
    if (t.dataset.stop) await api('/api/stop', { id: t.dataset.stop });
    else await api('/api/select', { id: t.dataset.sel });
  } catch (err) { msg(err.message); }
  status();
});
$('q').oninput = render; $('cat').onchange = render;
$('refresh').onclick = async () => { try { await api('/api/refresh', {}); load(); } catch (e) { msg(e.message); } };
for (const k of ['maxStreams', 'resolution', 'idleSec']) $(k).onchange = () => api('/api/settings', { [k]: $(k).value });
api('/api/settings').then(s => { for (const k of ['maxStreams', 'resolution', 'idleSec']) $(k).value = s[k]; $('enc').textContent = s.encoder === 'h264_nvenc' ? 'NVENC' : 'x264'; });
load(); status(); setInterval(status, 4000);
