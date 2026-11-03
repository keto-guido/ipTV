'use strict';
// Guide grid: time across, channels down. Paged (30 rows at a time) to stay light on phones.
// Everything comes from the server's local EPG cache.
const PX = 4 / 60, HOURS = 4, PAGE = 30; // px per second
let from = Math.floor(Date.now() / 1800e3) * 1800 - 1800, rows = [], shown = 0, more;
const g = $('g'), W = HOURS * 3600 * PX;

function header() {
  let t = '';
  for (let s = from; s < from + HOURS * 3600; s += 1800) t += `<span class="tk" style="left:${(s - from) * PX + 4}px">${hm(s)}</span>`;
  return `<div class="hdr"><div class="cn"></div><div class="tl" style="width:${W}px">${t}</div></div>`;
}
function rowHtml(c, progs) {
  const now = Date.now() / 1000, end = from + HOURS * 3600;
  const p = (progs || []).map(x => {
    const a = Math.max(x[0], from), b = Math.min(x[1], end);
    return `<div class="pg${x[0] <= now && x[1] > now ? ' live' : ''}" style="left:${(a - from) * PX}px;width:${Math.max((b - a) * PX - 2, 2)}px" title="${esc(hm(x[0]) + ' ' + x[2] + (x[3] ? ' — ' + x[3] : ''))}">${esc(x[2])}</div>`;
  }).join('');
  const nl = now > from && now < end ? `<div class="now" style="left:${(now - from) * PX}px"></div>` : '';
  return `<div class="gr"><div class="cn"><button class="star ${FAV.has(c.id) ? 'on' : ''}" data-star="${c.id}" style="font-size:13px;padding:0 2px">${FAV.has(c.id) ? '★' : '☆'}</button>${esc(c.name)}</div><div class="tl" style="width:${W}px">${p}${nl}</div></div>`;
}
async function page() {
  const chunk = rows.slice(shown, shown + PAGE); if (!chunk.length) return;
  shown += chunk.length;
  const e = await api(`/api/epg/range?from=${from}&hours=${HOURS}&ids=${chunk.map(c => c.id).join(',')}`).catch(() => ({}));
  more.insertAdjacentHTML('beforebegin', chunk.map(c => rowHtml(c, e[c.id])).join(''));
}
async function show() {
  const cat = $('cat').value;
  rows = cat === '*' ? await loadFavs() : await api('/api/lineup?cat=' + encodeURIComponent(cat));
  shown = 0;
  g.innerHTML = header() + '<div id="more" style="height:1px"></div>' + (rows.length ? '' : '<div class="dim" style="padding:20px">—</div>');
  more = $('more'); obs.observe(more);
  await page();
}
const obs = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) page(); }, { root: g, rootMargin: '400px' });
g.onclick = async e => { const s = e.target.closest('[data-star]'); if (!s) return; const on = await star(s.dataset.star); s.classList.toggle('on', on); s.textContent = on ? '★' : '☆'; };
$('cat').onchange = show;
$('prev').onclick = () => { from = Math.max(from - 7200, Math.floor(Date.now() / 1000) - 7200); show(); };
$('next').onclick = () => { from = Math.min(from + 7200, Math.floor(Date.now() / 1000) + 20 * 3600); show(); };
(async () => {
  const cats = (await api('/api/groups')).groups.filter(g => !g.hidden).sort((a, b) => a.name.localeCompare(b.name));
  $('cat').insertAdjacentHTML('beforeend', cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join(''));
  await loadFavs();
  if (!FAV.size && cats.length) $('cat').value = cats[0].id;
  show();
})();
