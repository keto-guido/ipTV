'use strict';
let data = { channels: [], categories: [] };
const msg = t => { $('info').textContent = t; };

async function status() {
  const s = await api('/api/status');
  const e = await nowNext(s.channels.map(c => c.id)).catch(() => ({}));
  $('active').innerHTML = s.channels.map(c => `<div class="card"><span class="n"><span>${esc(c.name)}</span><span class="sub">${nn(e[c.id])}</span></span>
   <span class="dim">${c.viewers ? '👁 ' + c.viewers : ''}</span><span class="st ${c.status}">${c.status}${c.retryIn ? ' ' + c.retryIn + 's' : ''}</span>
   ${c.status === 'down' ? `<button data-sel="${c.id}">↻</button>` : ''}<button data-stop="${c.id}">✕</button></div>`).join('');
}
let renderSeq = 0;
async function render() {
  const q = $('q').value.trim().toLowerCase(), cat = $('cat').value;
  const m = data.channels.filter(c => (cat === '*' ? FAV.has(c.id) : !cat || c.cat === cat) && (!q || c.name.toLowerCase().includes(q)));
  const shown = m.slice(0, 150), seq = ++renderSeq;
  const row = (c, e) => `<div class="card" data-sel="${c.id}"><button class="star ${FAV.has(c.id) ? 'on' : ''}" data-star="${c.id}">${FAV.has(c.id) ? '★' : '☆'}</button>${c.icon ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(c.icon)}" onerror="this.remove()">` : ''}<span class="n"><span>${esc(c.name)}</span><span class="sub">${nn(e && e[c.id])}</span></span></div>`;
  const tail = m.length > 150 ? `<div class="dim">+${m.length - 150}</div>` : '';
  $('list').innerHTML = shown.map(c => row(c)).join('') + tail;
  // Guide info comes from the local EPG cache only.
  const e = await nowNext(shown.map(c => c.id)).catch(() => ({}));
  if (seq === renderSeq) $('list').innerHTML = shown.map(c => row(c, e)).join('') + tail;
}
async function load() {
  try { data = await api('/api/channels'); } catch (e) { return msg(e.message); }
  const cats = data.categories.slice().sort((a, b) => a.name.localeCompare(b.name));
  $('cat').innerHTML = '<option value="*">★</option><option value="">All</option>' + cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  if (!FAV.size) $('cat').value = '';
  msg(`${data.channels.length} · ${new Date(data.fetchedAt).toLocaleString()}`); render();
}
let qt; 
document.addEventListener('click', async e => {
  const s = e.target.closest('[data-star]');
  if (s) { e.stopPropagation(); const on = await star(s.dataset.star); s.classList.toggle('on', on); s.textContent = on ? '★' : '☆'; return; }
  const t = e.target.closest('[data-sel],[data-stop]'); if (!t) return;
  try {
    if (t.dataset.stop) await api('/api/stop', { id: t.dataset.stop });
    else await api('/api/select', { id: t.dataset.sel });
  } catch (err) { msg(err.message); }
  status();
});
$('q').oninput = () => { clearTimeout(qt); qt = setTimeout(render, 200); }; $('cat').onchange = render;
$('refresh').onclick = async () => { try { await api('/api/refresh', {}); load(); } catch (e) { msg(e.message); } };
$('epgRefresh').onclick = async () => { msg('…'); try { const s = await api('/api/epg/refresh', {}); msg(`▦ ${s.channels} · ${s.sec}s`); render(); } catch (e) { msg(e.message); } };
for (const k of ['maxStreams', 'resolution', 'idleSec']) $(k).onchange = () => api('/api/settings', { [k]: $(k).value });
api('/api/settings').then(s => { for (const k of ['maxStreams', 'resolution', 'idleSec']) $(k).value = s[k]; $('enc').textContent = s.encoder === 'h264_nvenc' ? 'NVENC' : 'x264'; });
api('/api/epg/info').then(i => { $('epgRefresh').title = i.fetchedAt ? 'Guide ' + new Date(i.fetchedAt).toLocaleString() : 'Guide'; });
loadFavs().catch(() => {}).then(load); status(); setInterval(status, 4000);
