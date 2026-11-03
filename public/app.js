'use strict';
// Single-page phone-first viewer: Watch / Groups / Favs (+ Guide page). All lists are paged server-side.
const grid = $('grid'), empty = $('empty'), list = $('list');
const tiles = new Map(); // id -> {el, video, hls, loaded}
const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
const native = !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl') && (isSafari || !(window.Hls && Hls.isSupported()));
let S = { me: {}, channels: [], max: 1 }; // last /api/status
let G = { fav: 0, groups: [] };          // last /api/groups
let view = 'watch', cur = null;          // cur: {cat,name} when inside a group
const toast = t => { const e = $('toast'); e.textContent = t; e.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { e.hidden = true; }, 2600); };

// ---------- player ----------
function play(v) { v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); }
function attach(t, id) {
  const src = `${B}/hls/${id}/index.m3u8`;
  t.loaded = true;
  if (native) { t.video.src = src; play(t.video); return; }
  t.hls = new Hls({ liveSyncDurationCount: 3, manifestLoadingMaxRetry: 6, levelLoadingMaxRetry: 6, fragLoadingMaxRetry: 6 });
  t.hls.on(Hls.Events.ERROR, (e, d) => { if (d.fatal) detach(t); });
  t.hls.loadSource(src); t.hls.attachMedia(t.video);
  t.hls.on(Hls.Events.MANIFEST_PARSED, () => play(t.video));
}
function detach(t) {
  if (t.hls) { t.hls.destroy(); t.hls = null; }
  t.video.removeAttribute('src'); t.video.load(); t.loaded = false;
}
function fullscreen(t) {
  const v = t.video;
  if (document.fullscreenElement) return document.exitFullscreen();
  if (t.el.requestFullscreen && !/iPhone|iPod/.test(navigator.userAgent)) return t.el.requestFullscreen().catch(() => v.webkitEnterFullscreen && v.webkitEnterFullscreen());
  if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
}
async function pip(t) {
  const v = t.video;
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (v.requestPictureInPicture) await v.requestPictureInPicture();
    else if (v.webkitSetPresentationMode) v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
  } catch {}
}
const canPip = document.pictureInPictureEnabled || 'webkitSetPresentationMode' in HTMLVideoElement.prototype;

async function tick() {
  if (document.hidden) return;
  try { S = await api('/api/status'); } catch { return; }
  $('cog').hidden = !S.me.admin;
  const live = S.channels.filter(c => c.status !== 'down');
  const gone = [], added = [];
  for (const [id, t] of tiles) if (!live.find(c => c.id === id)) { detach(t); t.el.remove(); tiles.delete(id); gone.push(t.name); }
  for (const c of live) {
    let t = tiles.get(c.id);
    if (!t) {
      const el = document.createElement('div'); el.className = 'tile';
      el.innerHTML = `<video playsinline webkit-playsinline autoplay controls></video><div class="tag"><b></b><span></span></div><div class="tb">${canPip ? '<button class="ib" data-pip aria-label="Picture in picture">⧉</button>' : ''}<button class="ib" data-fs aria-label="Fullscreen">⛶</button></div>`;
      grid.appendChild(el);
      t = { el, video: el.querySelector('video'), name: c.name }; tiles.set(c.id, t);
      t.video.muted = live.length > 1;
      el.querySelector('[data-fs]').onclick = () => fullscreen(t);
      const pb = el.querySelector('[data-pip]'); if (pb) pb.onclick = () => pip(t);
      added.push(c.name);
    }
    const v = view === 'watch' ? await api('/api/watch/' + c.id, {}).catch(() => c) : c;
    t.el.querySelector('.tag b').textContent = c.name;
    t.el.querySelector('.tag span').textContent = v.ready ? (v.viewers > 1 ? ' · ' + v.viewers : '') : (v.status === 'backoff' ? ` · retry ${v.retryIn}s` : ' · starting…');
    if (v.ready && !t.loaded) attach(t, c.id);
    if (!v.ready && t.loaded && v.status !== 'running') detach(t);
  }
  if (gone.length && added.length) toast('Switched to ' + added.join(', '));
  else if (gone.length && !live.length) toast(gone.join(', ') + ' stopped');
  lastLive = live; layout(live);
  empty.hidden = live.length > 0;
  if (view === 'watch') renderNow();
  for (const el of list.querySelectorAll('.ch')) el.classList.toggle('on', isOn(el.dataset.id));
}

// Switcher: with 2+ active streams, one is shown and the others stay attached (muted, off-screen) so switching is instant.
let focus = null, lastLive = []; // focus: channel id or 'grid'
function layout(live) {
  const sw = $('switch');
  if (live.length < 2) { sw.hidden = true; for (const t of tiles.values()) t.el.classList.remove('bg'); grid.className = 'grid n' + live.length; return; }
  if (focus !== 'grid' && !tiles.has(focus)) focus = live[0].id;
  sw.hidden = true; // switching lives in ON NOW
  sw.innerHTML = live.map(c => `<button data-f="${c.id}" class="${focus === c.id ? 'on' : ''}">${esc(c.name)}</button>`).join('') + `<button data-f="grid" class="${focus === 'grid' ? 'on' : ''}" aria-label="Grid">?</button>`;
  for (const [id, t] of tiles) { const bg = focus !== 'grid' && id !== focus; t.el.classList.toggle('bg', bg); if (bg) t.video.muted = true; }
  grid.className = 'grid n' + (focus === 'grid' ? Math.min(live.length, 4) : 1);
}
$('switch').onclick = e => {
  const b = e.target.closest('[data-f]'); if (!b) return;
  focus = b.dataset.f; layout(lastLive);
  const t = tiles.get(focus); if (t) { for (const o of tiles.values()) o.video.muted = o !== t; t.video.muted = false; play(t.video); }
};

const sel = id => S.channels.find(c => c.id === id || c.rep === id); // matches representative or alternate id
const isOn = id => { const c = sel(id); return !!c && c.status !== 'down'; };
function watchCh(id) {
  focus = id; if (view !== 'watch') show('watch'); layout(lastLive);
  const t = tiles.get(id); if (t) { for (const o of tiles.values()) o.video.muted = o !== t; t.video.muted = false; play(t.video); }
  renderNow(true);
}

// ---------- navigation ----------
function show(v, opt = {}) {
  view = v;
  $('v-watch').hidden = v !== 'watch'; $('v-list').hidden = v !== 'groups' && v !== 'group'; $('v-manage').hidden = v !== 'manage';
  for (const b of document.querySelectorAll('.tabs [data-go]')) b.classList.toggle('on', b.dataset.go === (v === 'group' ? (cur && cur.cat === '*' ? 'favs' : 'groups') : v === 'manage' ? 'groups' : v));
  $('back').hidden = !(v === 'group' && cur.cat !== '*') && v !== 'manage';
  $('tool').hidden = v !== 'groups'; $('tool').textContent = 'Edit';
  $('title').textContent = v === 'watch' ? 'TV' : v === 'groups' ? 'Groups' : v === 'manage' ? 'Show groups' : cur.name;
  if (!opt.keepQ && (v === 'groups' || v === 'group')) $('q').value = '';
  if (v === 'groups') renderGroups();
  if (v === 'group') renderChannels(false);
  if (v === 'manage') renderManage();
  if (v === 'watch') tick().then(() => renderNow(true));
  scrollTo(0, 0);
}
function go(v) {
  if (v === 'favs') { cur = { cat: '*', name: 'Favorites' }; return show('group'); }
  show(v);
}
document.addEventListener('click', e => { const b = e.target.closest('[data-go]'); if (b) { e.preventDefault(); go(b.dataset.go); } });
$('back').onclick = () => show('groups');
$('tool').onclick = () => show('manage');

// ---------- groups ----------
async function loadGroups() { G = await api('/api/groups'); G.groups.sort((a, b) => a.name.localeCompare(b.name)); }
const visible = () => G.groups.filter(g => !g.hidden);
const grow = (id, name, n, cls = '') => `<div class="card grp ${cls}" data-cat="${esc(id)}" data-name="${esc(name)}"><span class="n">${esc(name)}</span><span class="cnt">${n}</span><span class="chev">›</span></div>`;
async function renderGroups() {
  await loadGroups().catch(e => toast(e.message));
  const q = $('q').value.trim().toLowerCase();
  if (q) return renderChannels(false);
  const v = visible(), hidden = G.groups.length - v.length;
  list.innerHTML = grow('*', '★ Favorites', G.fav, 'pin') + v.map(g => grow(g.id, g.name, g.n)).join('') +
    (v.length ? '' : '<div class="dim pad">All groups hidden</div>') +
    (hidden ? `<button class="ghost wide" data-manage>${hidden} hidden</button>` : '');
}

// ---------- channels (paged) ----------
let seq = 0, got = 0, total = 0, loading = false;
const crow = (c, e) => {
  const s = sel(c.id), on = s && s.status !== 'down', f = FAV.has(c.id);
  const w = on && (lastLive.length < 2 || focus === s.id);
  return `<div class="card ch${on ? ' on' : ''}${w ? ' watching' : ''}${s && !on ? ' down' : ''}" data-id="${c.id}" data-name="${esc(c.name)}">${c.icon ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(c.icon)}" onerror="this.style.visibility='hidden'">` : '<img alt="">'}<span class="n"><span>${esc(c.name)}</span><span class="sub">${nn(e && e[c.id])}</span></span><button class="star${f ? ' on' : ''}" data-star="${c.id}" aria-label="Favorite">${f ? '★' : '☆'}</button></div>`;
};
async function renderChannels(append) {
  const s = ++seq, q = $('q').value.trim();
  const cat = view === 'group' ? cur.cat : '';
  if (!append) { got = 0; total = 0; }
  if (append && (loading || got >= total)) return;
  loading = true;
  try {
    const qs = new URLSearchParams({ q, cat, offset: got, limit: 60 });
    const r = await api('/api/browse?' + qs);
    if (s !== seq) return;
    const e = await nowNext(r.items.map(c => c.id)).catch(() => ({}));
    if (s !== seq) return;
    let html = r.items.map(c => crow(c, e)).join('');
    if (!append && view === 'groups' && q) { // search: matching groups first
      const ql = q.toLowerCase();
      const now = Date.now() / 1000;
      const ep = (r.epg || []).map(h => `<div class="card ch" data-id="${h.c.id}" data-name="${esc(h.c.name)}">${h.c.icon ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(h.c.icon)}" onerror="this.style.visibility='hidden'">` : '<img alt="">'}<span class="n"><span>${esc(h.p[2])}</span><span class="sub">${h.p[0] <= now ? '<b class="lv">Live now</b>' : hm(h.p[0])} � ${esc(h.c.name)}</span></span></div>`).join('');
      html = visible().filter(g => g.name.toLowerCase().includes(ql)).slice(0, 20).map(g => grow(g.id, g.name, g.n)).join('') + (ep ? '<h2 class="sec">Guide</h2>' + ep + (html ? '<h2 class="sec">Channels</h2>' : '') : '') + html;
    }
    got += r.items.length; total = r.total;
    $('more')?.remove();
    if (append) list.insertAdjacentHTML('beforeend', html); else list.innerHTML = html || '<div class="dim pad">—</div>';
    if (got < total) { list.insertAdjacentHTML('beforeend', '<div id="more" class="dim pad">…</div>'); obs.observe($('more')); }
  } catch (err) { toast(err.message); } finally { loading = false; }
}
const obs = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) renderChannels(true); }, { rootMargin: '600px' });
let qt; $('q').oninput = () => { clearTimeout(qt); qt = setTimeout(() => (view === 'groups' ? renderGroups() : renderChannels(false)), 250); };

const onRows = async e => {
  const st = e.target.closest('[data-star]');
  if (st) { const on = await star(st.dataset.star).catch(() => null); if (on != null) { st.classList.toggle('on', on); st.textContent = on ? '★' : '☆'; } return; }
  if (e.target.closest('[data-manage]')) return show('manage');
  const g = e.target.closest('.grp');
  if (g) { cur = { cat: g.dataset.cat, name: g.dataset.cat === '*' ? 'Favorites' : g.dataset.name }; return show('group'); }
  const c = e.target.closest('.ch'); if (c) pick(c.dataset.id, c.dataset.name);
};
list.onclick = onRows; $('nowlist').onclick = onRows;

// Watch view: on-now rows with now/next + favorites as a quick-switch list.
let nowKey = '', nowAt = 0;
async function renderNow(force) {
  const live = S.channels.filter(c => c.status !== 'down');
  const key = S.channels.map(c => c.id + c.status).join() + '|' + FAV.size + '|' + focus;
  if (!force && key === nowKey && Date.now() - nowAt < 60e3) return;
  nowKey = key; nowAt = Date.now();
  const favs = await loadFavs().catch(() => []);
  const ids = [...new Set([...live.map(c => c.id), ...favs.map(c => c.id)])].slice(0, 300);
  const e = await nowNext(ids).catch(() => ({}));
  const a = S.channels.map(c => crow({ id: c.id, name: c.name }, e)).join('');
  const b = favs.filter(f => !sel(f.id)).slice(0, 60).map(c => crow(c, e)).join('');
  $('nowlist').innerHTML = (a ? '<h2>On now</h2>' + a : '') + (b ? '<h2>Favorites</h2>' + b : '');
}

// ---------- tap to watch / replace ----------
function sheet(msg, btns) {
  if (!msg || !btns || !btns.length) return;
  $('smsg').textContent = msg;
  $('sbtn').innerHTML = btns.map((b, i) => `<button data-i="${i}" class="${b.cls || ''}">${esc(b.t)}</button>`).join('');
  $('sheet').hidden = false;
  $('sbtn').onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; $('sheet').hidden = true; btns[b.dataset.i].f(); };
}
$('sheet').hidden = true;
$('scancel').onclick = () => { $('sheet').hidden = true; };
$('sheet').onclick = e => { if (e.target.id === 'sheet') $('sheet').hidden = true; };

async function pick(id, name) {
  await tick();
  const mine = S.channels.find(c => c.id === id);
  if (mine && mine.status !== 'down') return show('watch');
  if (!S.me.admin) return toast(mine ? 'Channel is down' : 'Not on · ask an admin to start it');
  const others = S.channels.filter(c => c.id !== id);
  if (mine || !others.length) return start(id, name);
  const under = S.channels.length < S.max;
  const btns = others.map(c => ({ t: 'Replace ' + c.name, cls: under ? '' : 'pri', f: () => replace(c.id, id, name) }));
  if (under) btns.unshift({ t: 'Add', cls: 'pri', f: () => start(id, name) });
  sheet(under ? `Play ${name}?` : `${name}: replace which?`, btns);
}
async function start(id, name) {
  try { await api('/api/select', { id }); focus = id; toast('Starting ' + name); show('watch'); }
  catch (e) { toast(e.message === 'cap reached' ? 'Limit reached' : e.message); }
}
async function replace(old, id, name) {
  toast('Switching…');
  try { await api('/api/replace', { old, id }); focus = id; toast('Starting ' + name); show('watch'); }
  catch (e) { toast(e.message === 'cap reached' ? 'Limit reached' : e.message); }
}

// ---------- manage (hide/show groups) ----------
let saveT;
function saveHidden() { clearTimeout(saveT); saveT = setTimeout(() => api('/api/groups/hidden', { ids: G.groups.filter(g => g.hidden).map(g => g.id) }).catch(e => toast(e.message)), 400); }
function mFiltered() { const q = $('mq').value.trim().toLowerCase(); return q ? G.groups.filter(g => g.name.toLowerCase().includes(q)) : G.groups; }
async function renderManage() {
  if (!G.groups.length) await loadGroups().catch(e => toast(e.message));
  const v = mFiltered();
  $('mcount').textContent = `${G.groups.filter(g => !g.hidden).length}/${G.groups.length}`;
  $('mlist').innerHTML = v.map(g => `<label class="card tg"><span class="n">${esc(g.name)}</span><span class="cnt">${g.n}</span><input type="checkbox" data-g="${esc(g.id)}"${g.hidden ? '' : ' checked'}><i class="sw"></i></label>`).join('') || '<div class="dim pad">—</div>';
}
$('mlist').onchange = e => { const g = G.groups.find(x => x.id === e.target.dataset.g); if (!g) return; g.hidden = !e.target.checked || undefined; $('mcount').textContent = `${G.groups.filter(g => !g.hidden).length}/${G.groups.length}`; saveHidden(); };
const setAll = hide => { for (const g of mFiltered()) g.hidden = hide || undefined; saveHidden(); renderManage(); };
$('showall').onclick = () => setAll(false); $('hideall').onclick = () => setAll(true);
let mt; $('mq').oninput = () => { clearTimeout(mt); mt = setTimeout(renderManage, 150); };

// ---------- boot ----------
loadFavs().catch(() => {});
tick().then(() => { const h = location.hash.slice(1); if (/^(watch|groups|favs)$/.test(h)) { history.replaceState(null, '', location.pathname); go(h); } else show(tiles.size ? 'watch' : 'groups'); });
setInterval(tick, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
