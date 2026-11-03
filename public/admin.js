'use strict';
const msg = t => { $('info').textContent = t; };

async function status() {
  const s = await api('/api/status');
  const e = await nowNext(s.channels.map(c => c.id)).catch(() => ({}));
  $('active').innerHTML = s.channels.map(c => `<div class="card"><span class="n"><span>${esc(c.name)}</span><span class="sub">${nn(e[c.id])}</span></span>
   <span class="dim">${c.viewers ? '👁 ' + c.viewers : ''}</span><span class="st ${c.status}">${c.status}${c.retryIn ? ' ' + c.retryIn + 's' : ''}</span>
   ${c.status === 'down' ? `<button data-sel="${c.id}">↻</button>` : ''}<button data-stop="${c.id}">✕</button></div>`).join('');
}
let renderSeq = 0, items = [], total = 0;
const row = (c, e) => `<div class="card" data-sel="${c.id}"><button class="star ${FAV.has(c.id) ? 'on' : ''}" data-star="${c.id}">${FAV.has(c.id) ? '★' : '☆'}</button>${c.icon ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(c.icon)}" onerror="this.remove()">` : ''}<span class="n"><span>${esc(c.name)}</span><span class="sub">${nn(e && e[c.id])}</span></span></div>`;
async function render(append) {
  const seq = ++renderSeq;
  const qs = new URLSearchParams({ q: $('q').value.trim(), cat: $('cat').value, offset: append ? items.length : 0, limit: 50 });
  let r; try { r = await api('/api/search?' + qs); } catch (e) { return msg(e.message); }
  if (seq !== renderSeq) return;
  const e = await nowNext(r.items.map(c => c.id)).catch(() => ({}));
  if (seq !== renderSeq) return;
  items = append ? items.concat(r.items) : r.items; total = r.total;
  const html = r.items.map(c => row(c, e)).join('');
  if (append) { $('more')?.remove(); $('list').insertAdjacentHTML('beforeend', html); } else $('list').innerHTML = html;
  if (items.length < total) $('list').insertAdjacentHTML('beforeend', `<button id="more" style="width:100%">+${total - items.length}</button>`);
  msg(`${r.count} · ${new Date(r.fetchedAt).toLocaleString()}`);
}
async function load() {
  try {
    const cats = (await api('/api/categories')).sort((a, b) => a.name.localeCompare(b.name));
    $('cat').innerHTML = '<option value="*">★</option><option value="">All</option>' + cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  } catch (e) { msg(e.message); }
  if (!FAV.size) $('cat').value = '';
  render();
}
let qt; 
document.addEventListener('click', async e => {
  const s = e.target.closest('[data-star]');
  if (s) { e.stopPropagation(); const on = await star(s.dataset.star); s.classList.toggle('on', on); s.textContent = on ? '★' : '☆'; return; }
  if (e.target.id === 'more') return render(true);
  const t = e.target.closest('[data-sel],[data-stop]'); if (!t) return;
  try {
    if (t.dataset.stop) await api('/api/stop', { id: t.dataset.stop });
    else await api('/api/select', { id: t.dataset.sel });
  } catch (err) { msg(err.message); }
  status();
});
$('q').oninput = () => { clearTimeout(qt); qt = setTimeout(() => render(), 250); }; $('cat').onchange = () => render();
$('refresh').onclick = async () => { try { await api('/api/refresh', {}); load(); } catch (e) { msg(e.message); } };
$('epgRefresh').onclick = async () => { msg('…'); try { const s = await api('/api/epg/refresh', {}); msg(`▦ ${s.channels} · ${s.sec}s`); render(); } catch (e) { msg(e.message); } };
for (const k of ['maxStreams', 'resolution', 'idleSec']) $(k).onchange = () => api('/api/settings', { [k]: $(k).value });
api('/api/settings').then(s => { for (const k of ['maxStreams', 'resolution', 'idleSec']) $(k).value = s[k]; $('enc').textContent = s.encoder === 'h264_nvenc' ? 'NVENC' : 'x264'; });
api('/api/epg/info').then(i => { $('epgRefresh').title = i.fetchedAt ? 'Guide ' + new Date(i.fetchedAt).toLocaleString() : 'Guide'; });
loadFavs().catch(() => {}).then(load); status(); setInterval(status, 4000);
