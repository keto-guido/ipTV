'use strict';
// Guide tab inside the SPA: time across, channels down, 30 rows per page, local EPG cache only.
// Tapping a channel or programme goes through the same start/replace flow (pick() in app.js).
const Guide = (() => {
  const PX = 4 / 60, HOURS = 4, PAGE = 30;
  let from = 0, rows = [], shown = 0, more = null, ready = false, seq = 0;
  const g = $('g'), W = HOURS * 3600 * PX;
  const base = () => Math.floor(Date.now() / 1800e3) * 1800 - 1800;
  function header() {
    let t = '';
    for (let s = from; s < from + HOURS * 3600; s += 1800) t += `<span class="tk" style="left:${(s - from) * PX + 4}px">${hm(s)}</span>`;
    return `<div class="hdr"><div class="cn"></div><div class="tl" style="width:${W}px">${t}</div></div>`;
  }
  function rowHtml(c, progs) {
    const now = Date.now() / 1000, end = from + HOURS * 3600, d = `data-id="${c.id}" data-name="${esc(c.name)}"`;
    const p = (progs || []).map(x => {
      const a = Math.max(x[0], from), b = Math.min(x[1], end);
      return `<div class="pg${x[0] <= now && x[1] > now ? ' live' : ''}" ${d} style="left:${(a - from) * PX}px;width:${Math.max((b - a) * PX - 2, 2)}px">${esc(x[2])}</div>`;
    }).join('');
    const nl = now > from && now < end ? `<div class="now" style="left:${(now - from) * PX}px"></div>` : '';
    const f = FAV.has(c.id);
    return `<div class="gr"><div class="cn"><button class="star${f ? ' on' : ''}" data-star="${c.id}">${f ? '\u2605' : '\u2606'}</button><span class="gch" ${d}>${esc(c.name)}</span></div><div class="tl" style="width:${W}px">${p}${nl}</div></div>`;
  }
  async function page() {
    const s = seq, chunk = rows.slice(shown, shown + PAGE); if (!chunk.length) return;
    shown += chunk.length;
    const e = await api(`/api/epg/range?from=${from}&hours=${HOURS}&ids=${chunk.map(c => c.id).join(',')}`).catch(() => ({}));
    if (s === seq && more) more.insertAdjacentHTML('beforebegin', chunk.map(c => rowHtml(c, e[c.id])).join(''));
  }
  const obs = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) page(); }, { root: g, rootMargin: '400px' });
  async function render() {
    const s = ++seq, cat = $('gcat').value;
    const r = cat === '*' ? await loadFavs().catch(() => []) : await api('/api/lineup?cat=' + encodeURIComponent(cat)).catch(() => []);
    if (s !== seq) return;
    rows = r; shown = 0;
    g.innerHTML = header() + '<div id="gmore" style="height:1px"></div>' + (rows.length ? '' : '<div class="dim pad">\u2014</div>');
    more = $('gmore'); obs.disconnect(); obs.observe(more);
    await page();
  }
  g.addEventListener('click', async e => {
    const st = e.target.closest('[data-star]');
    if (st) { const on = await star(st.dataset.star).catch(() => null); if (on != null) { st.classList.toggle('on', on); st.textContent = on ? '\u2605' : '\u2606'; } return; }
    const c = e.target.closest('[data-id]'); if (c) pick(c.dataset.id, c.dataset.name);
  });
  $('gcat').onchange = render;
  $('gprev').onclick = () => { from = Math.max(from - 7200, Math.floor(Date.now() / 1000) - 7200); render(); };
  $('gnext').onclick = () => { from = Math.min(from + 7200, Math.floor(Date.now() / 1000) + 20 * 3600); render(); };
  return {
    async open() {
      if (!from) from = base();
      if (!ready) {
        ready = true;
        const gs = (await api('/api/groups').catch(() => ({ groups: [] }))).groups.filter(x => !x.hidden).sort((a, b) => a.name.localeCompare(b.name));
        $('gcat').insertAdjacentHTML('beforeend', gs.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join(''));
        await loadFavs().catch(() => {});
        if (!FAV.size && gs.length) $('gcat').value = gs[0].id;
      }
      render();
    },
  };
})();
