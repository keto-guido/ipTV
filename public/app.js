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

// Playback-bound switch notice, independent of short action/error toasts.
const switchToast = document.createElement('div');
switchToast.className = 'switch-toast'; switchToast.hidden = true;
switchToast.setAttribute('role', 'status'); document.body.appendChild(switchToast);
let pendingSwitch = null, switchTimer, seenSwitch = null;
function hideSwitch() { switchToast.hidden = true; pendingSwitch = null; clearTimeout(switchTimer); }
function showSwitch(s) {
  if (!s || !s.switchedAt || Date.now() - s.switchedAt >= 15000) return;
  if (pendingSwitch && s.switchedAt < pendingSwitch.switchedAt) return;
  const identity = s.id + ':' + s.switchedAt;
  if (identity === seenSwitch && !pendingSwitch) return;
  if (identity !== seenSwitch) {
    seenSwitch = identity; clearTimeout(switchTimer);
    switchTimer = setTimeout(hideSwitch, Math.max(0, 15000 - (Date.now() - s.switchedAt)));
  }
  pendingSwitch = { ...s, switchSeq: null, switchPdt: null, ...s.phoneSwitch };
  switchToast.replaceChildren();
  const spinner = document.createElement('span'); spinner.className = 'switch-spinner'; switchToast.appendChild(spinner);
  const img = document.createElement('img'); img.src = s.logo || B + '/api/logo/' + encodeURIComponent(s.id); img.alt = '';
  img.onerror = () => img.remove(); switchToast.appendChild(img);
  switchToast.appendChild(document.createTextNode('Switching to ' + s.name)); switchToast.hidden = false;
  if (main.fragment) checkSwitch(main.fragment);
}
function checkSwitch(frag) {
  const s = pendingSwitch;
  if (!s) return;
  const pdt = typeof frag.programDateTime === 'number' ? frag.programDateTime : Date.parse(frag.programDateTime);
  if ((s.switchSeq != null && Number.isFinite(+frag.sn) && +frag.sn >= s.switchSeq) ||
      (s.switchPdt && Number.isFinite(pdt) && pdt >= Date.parse(s.switchPdt))) hideSwitch();
}

// ---------- player ----------
// Sound: remember the user's mute choice; try unmuted first, fall back to muted + one big "Tap for sound".
const pref = { get muted() { return localStorage.getItem('tvMuted') === '1'; }, set(m) { try { localStorage.setItem('tvMuted', m ? '1' : '0'); } catch {} } };
let ours = false; // true while the app (not the user) changes muted
function setMuted(v, m) { if (v.muted === m) return; ours = true; v.muted = m; setTimeout(() => { ours = false; }, 0); }
const front = () => [...tiles.values()].find(t => !t.el.classList.contains('bg'));
document.body.insertAdjacentHTML('beforeend', '<button id="tapsnd" class="tapsnd" hidden>\u{1F50A} Tap for sound</button>');
let gate = null;
function soundGate(on) {
  $('tapsnd').hidden = !on;
  if (!on) { if (gate) { document.removeEventListener('touchend', gate, true); document.removeEventListener('click', gate, true); gate = null; } return; }
  if (gate) return;
  gate = () => { const t = front(); soundGate(false); if (t) { setMuted(t.video, false); pref.set(false); t.video.play().catch(() => {}); } };
  document.addEventListener('touchend', gate, true); document.addEventListener('click', gate, true);
}
function play(v) {
  const bg = !!v.closest('.tile.bg'), want = !bg && !pref.muted;
  setMuted(v, !want);
  v.play().then(() => { if (want) soundGate(false); }).catch(() => {
    if (!want) return;
    setMuted(v, true); v.play().catch(() => {}); soundGate(true);
  });
}
function resume() { const t = front(); if (t && t.loaded && t.video.paused) play(t.video); }
const HLS_CONFIG = { liveSyncDurationCount: 3, maxLiveSyncPlaybackRate: 1.05, backBufferLength: 30, manifestLoadingMaxRetry: 6, levelLoadingMaxRetry: 6, fragLoadingMaxRetry: 6 };
function attach(t) {
  const src = t.live ? `${B}/hls/live/phone/index.m3u8` : `${B}/hls/${t.id}/index.m3u8`;
  t.loaded = true;
  if (native) {
    t.video.onerror = () => reattach(t);
    t.video.onplaying = () => healthy(t);
    t.video.src = src; play(t.video); return;
  }
  const hls = t.hls = new Hls(HLS_CONFIG);
  hls.on(Hls.Events.ERROR, (e, d) => { if (d.fatal && t.hls === hls) onFatal(t, d); });
  hls.on(Hls.Events.FRAG_BUFFERED, () => healthy(t));
  hls.on(Hls.Events.FRAG_CHANGED, (_, data) => { if (t.live) { t.fragment = data.frag; checkSwitch(data.frag); } });
  hls.loadSource(src); hls.attachMedia(t.video);
  hls.on(Hls.Events.MANIFEST_PARSED, () => play(t.video));
}
function detach(t) {
  if (t.hls) { t.hls.destroy(); t.hls = null; }
  t.fragment = null;
  t.video.onerror = t.video.onplaying = null;
  t.video.removeAttribute('src'); t.video.load(); t.loaded = false;
}
function healthy(t) { if (t.tries || t.note) { t.tries = 0; t.note = ''; paint(t); } }
// Media errors are fixed in place; a second one within 30 s also swaps the audio codec, a third rebuilds the player.
function onFatal(t, d) {
  if (d.type !== Hls.ErrorTypes.MEDIA_ERROR) return reattach(t);
  if (Date.now() - (t.mediaAt || 0) > 30e3) t.media = 0;
  t.mediaAt = Date.now(); t.media = (t.media || 0) + 1;
  if (t.media > 2) { t.media = 0; return reattach(t); }
  if (t.media === 2) t.hls.swapAudioCodec();
  t.hls.recoverMediaError();
  play(t.video);
  t.note = 'Recovering playback…'; paint(t);
}
// Rebuilds the player after an exponential delay; tick() does the attach. Only for fatal errors: channel changes never get here.
function reattach(t) {
  if (t.timer) return;
  detach(t);
  t.tries = (t.tries || 0) + 1; t.note = 'Reconnecting…';
  const ms = Math.min(2000 * 2 ** (t.tries - 1), 60e3) * (0.8 + Math.random() * 0.4);
  t.timer = setTimeout(() => { t.timer = null; tick(); }, ms);
  paint(t);
}
// Status overlay on a tile, from the last server view (t.v) and the local player state.
function paint(t) {
  const v = t.v || {}, down = v.status === 'down';
  const text = down ? `Channel down: ${v.reason || 'unknown reason'}`
    : v.status === 'backoff' ? `Reconnecting in ${v.retryIn}s${v.reason ? ' · ' + v.reason : ''}` : t.note;
  const m = t.el.querySelector('.msg');
  m.hidden = !text; m.querySelector('span').textContent = text || '';
  m.querySelector('button').hidden = !down;
  t.el.classList.toggle('isdown', down);
  t.el.classList.toggle('wait', !down && (!v.ready || !!t.timer));
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
// One persistent main <video> and player on the live playlist: a channel change happens inside the stream, so iOS keeps
// its unmuted user activation. Further channels (cap above 1) get ordinary tiles on their own playlists.
const ICON_ON = '<svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';
const ICON_OFF = '<svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 9l6 6M22 9l-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
function makeTile() {
  const el = document.createElement('div'); el.className = 'tile';
  el.innerHTML = `<video playsinline webkit-playsinline autoplay x-webkit-airplay="allow"></video><div class="spin"></div><div class="tag"><b></b><span></span></div><button class="unmute" data-unmute>Tap for sound \u{1F50A}</button><div class="msg" hidden><span></span><button data-retry hidden>Retry</button></div><button class="ib big snd" data-snd aria-label="Sound"><i class="on">${ICON_ON}</i><i class="off">${ICON_OFF}</i></button><div class="tb">${canPip ? '<button class="ib big" data-pip aria-label="Picture in picture">\u29c9</button>' : ''}<button class="ib big" data-fs aria-label="Fullscreen">\u26f6</button></div>`;
  grid.appendChild(el);
  const v = el.querySelector('video');
  v.muted = pref.muted;
  const sync = () => el.classList.toggle('muted', v.muted);
  v.addEventListener('volumechange', () => { sync(); if (!ours && !el.classList.contains('bg')) { pref.set(v.muted); if (!v.muted) soundGate(false); } });
  sync();
  el.addEventListener('click', e => {
    const t = el._t; if (!t) return;
    const snd = e.target.closest('[data-snd]');
    if (document.body.classList.contains('mini') && !snd) return; // grid handler expands the mini player
    if (e.target.closest('[data-retry]')) return retry(t.id, t.name);
    if (e.target.closest('[data-fs]')) return fullscreen(t);
    if (e.target.closest('[data-pip]')) return pip(t);
    if (snd) { const m = !v.muted; setMuted(v, m); pref.set(m); sync(); if (!m) { soundGate(false); v.play().catch(() => {}); } return; }
    if (v.muted) { setMuted(v, false); pref.set(false); sync(); soundGate(false); v.play().catch(() => {}); }
  });
  return el;
}
const main = { el: makeTile(), live: true, id: null, name: '' };
main.el.querySelector('video').addEventListener('timeupdate', () => {
  const v = main.video;
  if (pendingSwitch && pendingSwitch.switchPdt && typeof v.getStartDate === 'function') {
    const start = +v.getStartDate();
    if (Number.isFinite(start) && start + v.currentTime * 1000 >= Date.parse(pendingSwitch.switchPdt)) hideSwitch();
  }
});
const mainVideo = main.video = main.el.querySelector('video');
main.el.hidden = true; main.el._t = main;
// Nothing on: the player stays attached but stops fetching slate.
function mainIdle(on) {
  if (main.hls) { if (on) main.hls.stopLoad(); else main.hls.startLoad(-1); }
  if (!on && main.loaded) play(mainVideo);
}
// Called synchronously inside a tap, before any await: keeps/primes unmuted playback on the main element.
function prime() {
  if (pref.muted) return;
  const t = front(), v = t ? t.video : mainVideo;
  setMuted(v, false); const p = v.play(); if (p) p.catch(() => {});
}

// Status events and the timer can land while a pass is running; passes never overlap, and one more runs afterwards.
let ticking = null, again = false;
function tick() {
  if (ticking) { again = true; return ticking; }
  return ticking = refresh().finally(() => { ticking = null; if (again) { again = false; tick(); } });
}
async function refresh() {
  if (document.hidden) return;
  try { S = await api('/api/status'); } catch { return; }
  showSwitch(S.live);
  $('cog').hidden = !S.me.admin;
  const live = S.channels; // a down channel keeps its tile, to show why and offer a retry
  const liveId = S.live ? S.live.id : null;
  const gone = [], added = [];
  for (const [id, t] of tiles) if (t !== main && (id === liveId || !live.find(c => c.id === id))) { clearTimeout(t.timer); detach(t); t.el.remove(); tiles.delete(id); if (id !== liveId) gone.push(t.name); }
  if (main.id !== liveId) {
    if (main.id) { tiles.delete(main.id); gone.push(main.name); }
    main.id = liveId; main.name = liveId ? S.live.name : ''; main.v = null; main.el.hidden = !liveId;
    if (liveId) { tiles.set(liveId, main); added.push(main.name); }
    mainIdle(!liveId);
  }
  for (const c of live) {
    let t = tiles.get(c.id);
    if (!t) {
      const el = makeTile();
      t = { el, video: el.querySelector('video'), id: c.id, name: c.name }; tiles.set(c.id, t); el._t = t;
      added.push(c.name);
    }
    const v = view === 'watch' ? await api('/api/watch/' + c.id, {}).catch(() => c) : c;
    t.el.querySelector('.tag b').textContent = c.name;
    t.v = v;
    t.el.querySelector('.tag span').textContent = v.ready ? (v.viewers > 1 ? ' · ' + v.viewers : '') : (v.status === 'down' ? ' · down' : v.status === 'backoff' ? ` · retry ${v.retryIn}s` : ' · starting…');
    if (t.live) { if (!t.loaded && !t.timer) attach(t); } // plays slate until the channel is up
    else {
      if (v.ready && !t.loaded && !t.timer) attach(t);
      if (!v.ready && t.loaded && v.status !== 'running') detach(t);
    }
    paint(t);
  }
  if (gone.length && added.length) showSwitch(S.live);
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
  sw.innerHTML = live.map(c => `<button data-f="${c.id}" class="${focus === c.id ? 'on' : ''}">${esc(c.name)}</button>`).join('') + `<button data-f="grid" class="${focus === 'grid' ? 'on' : ''}" aria-label="Grid">▦</button>`;
  for (const [id, t] of tiles) { const bg = focus !== 'grid' && id !== focus; t.el.classList.toggle('bg', bg); if (bg) setMuted(t.video, true); }
  grid.className = 'grid n' + (focus === 'grid' ? Math.min(live.length, 4) : 1);
}
$('switch').onclick = e => {
  const b = e.target.closest('[data-f]'); if (!b) return;
  focus = b.dataset.f; layout(lastLive);
  const t = tiles.get(focus); if (t) { for (const o of tiles.values()) if (o !== t) setMuted(o.video, true); play(t.video); }
};

const sel = id => S.channels.find(c => c.id === id || c.rep === id); // matches representative or alternate id
const isOn = id => { const c = sel(id); return !!c && c.status !== 'down'; };
function watchCh(id) {
  focus = id; if (view !== 'watch') show('watch'); layout(lastLive);
  const t = tiles.get(id); if (t) { for (const o of tiles.values()) if (o !== t) setMuted(o.video, true); play(t.video); }
  renderNow(true);
}

// ---------- navigation ----------
function show(v, opt = {}) {
  view = v;
  $('v-sports').hidden = v !== 'sports';
  if (v === 'sports') renderSports();
  $('v-watch').hidden = v !== 'watch'; $('v-list').hidden = v !== 'groups' && v !== 'group'; $('v-manage').hidden = v !== 'manage'; $('v-guide').hidden = v !== 'guide';
  document.body.classList.toggle('mini', v !== 'watch'); for (const t of tiles.values()) t.video.controls = false;
  for (const b of document.querySelectorAll('.tabs [data-go]')) b.classList.toggle('on', b.dataset.go === (v === 'group' ? (cur && cur.cat === '*' ? 'favs' : 'groups') : v === 'manage' ? 'groups' : v));
  $('back').hidden = !(v === 'group' && cur.cat !== '*') && v !== 'manage';
  $('tool').hidden = v !== 'groups'; $('tool').textContent = 'Edit';
  $('title').textContent = v === 'watch' ? 'TV' : v === 'groups' ? 'Groups' : v === 'manage' ? 'Show groups' : v === 'guide' ? 'Guide' : v === 'sports' ? 'Sports' : cur.name;
  if (!opt.keepQ && (v === 'groups' || v === 'group')) $('q').value = '';
  if (v === 'groups') renderGroups();
  if (v === 'group') renderChannels(false);
  if (v === 'manage') renderManage();
  if (v === 'guide') Guide.open();
  route(v, opt.pop);
  if (v === 'watch') tick().then(() => renderNow(true));
  scrollTo(0, 0);
}
// Hash routing: refresh and iOS back/forward land on the same tab; the player is never reloaded.
function route(v, pop) {
  const h = '#' + (v === 'group' ? (cur.cat === '*' ? 'favs' : 'g:' + encodeURIComponent(cur.cat)) : v);
  if (location.hash !== h) history[pop ? 'replaceState' : 'pushState'](null, '', h);
}
function fromHash(pop) {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('g:')) { const x = G.groups.find(y => y.id === h.slice(2)); cur = { cat: h.slice(2), name: x ? x.name : '' }; show('group', { pop }); return true; }
  if (h === 'favs') { cur = { cat: '*', name: 'Favorites' }; show('group', { pop }); return true; }
  if (/^(watch|groups|guide|manage|sports)$/.test(h)) { show(h, { pop }); return true; }
  return false;
}
window.addEventListener('popstate', () => { if (!fromHash(true)) show('watch', { pop: true }); });
// Mini player: tap to expand back to Watch.
grid.addEventListener('click', e => { if (document.body.classList.contains('mini') && !e.target.closest('[data-snd]')) { e.preventDefault(); e.stopPropagation(); show('watch'); } }, true);
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
      const ep = (r.epg || []).map(h => `<div class="card ch" data-id="${h.c.id}" data-name="${esc(h.c.name)}">${h.c.icon ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(h.c.icon)}" onerror="this.style.visibility='hidden'">` : '<img alt="">'}<span class="n"><span>${esc(h.p[2])}</span><span class="sub">${h.p[0] <= now ? '<b class="lv">Live now</b>' : hm(h.p[0])} · ${esc(h.c.name)}</span></span></div>`).join('');
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
  prime();
  await tick();
  const mine = sel(id);
  if (mine && mine.status !== 'down') return watchCh(mine.id);
  if (!S.me.admin) return mine ? retry(mine.id, mine.name) : toast('Not on · ask an admin to start it');
  if (mine) { id = mine.id; name = mine.name; }
  const others = S.channels.filter(c => c !== mine);
  if (!others.length) return start(id, name);
  const under = S.channels.length - (mine ? 1 : 0) < S.max;
  const btns = others.map(c => ({ t: 'Replace ' + c.name + (c.status === 'down' ? ' (down)' : ''), cls: under ? '' : 'pri', f: () => replace(c.id, id, name) }));
  if (under) btns.unshift({ t: mine ? 'Retry' : 'Add', cls: 'pri', f: () => start(id, name) });
  sheet(under ? `Play ${name}?` : `${name}: replace which?`, btns);
}
async function start(id, name) {
  prime();
  try { await api('/api/select', { id }); focus = id; toast('Starting ' + name); show('watch'); }
  catch (e) { toast(e.message === 'cap reached' ? 'Limit reached' : e.message); }
}
async function retry(id, name) {
  prime();
  try { const v = await api('/api/retry/' + id, {}); focus = id; toast(v.retryIn ? `Retrying ${name} in ${v.retryIn}s` : 'Retrying ' + name); show('watch'); }
  catch (e) { toast(e.message); }
}
async function replace(old, id, name) {
  prime();
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
tick().then(async () => { await loadGroups().catch(() => {}); if (!fromHash(true)) show(tiles.size ? 'watch' : 'groups', { pop: true }); });
// Status changes arrive by SSE; the slow poll is the fallback, and also carries the /api/watch wake-up.
setInterval(tick, 20e3);
function listen() {
  if (!window.EventSource) return;
  const es = new EventSource(B + '/api/events'); // same-origin: the session cookie goes along, so no token in the URL
  es.addEventListener('switching', e => { try { showSwitch(JSON.parse(e.data)); } catch {} });
  es.addEventListener('state', e => { try { showSwitch(JSON.parse(e.data).live); } catch {} tick(); });
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) setTimeout(listen, 30e3); }; // refused; ordinary drops reconnect by themselves
}
listen();
// Keeps the idle timer from expiring under a viewer; ?keepalive=1 can never start a stream.
setInterval(() => {
  if (document.hidden) return;
  for (const t of tiles.values()) if (t.loaded && !t.video.paused) api(`/api/watch/${t.id}?keepalive=1`, {}).catch(() => {});
}, 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { resume(); tick(); } });
window.addEventListener('pageshow', e => { if (e.persisted) { resume(); tick(); } });

let sportsBusy = false, sportsTeams = [];
async function renderSports() {
 if (sportsBusy || view !== 'sports' || document.hidden) return;
 sportsBusy = true;
 try {
  const [data, teams] = await Promise.all([api('/api/sports/today'), api('/api/sports/teams')]); sportsTeams = teams;
  const root = $('sports-list'); root.replaceChildren();
  for (const [key,label] of [['live','Live now'],['later','Later'],['finished','Final']]) {
   const heading=document.createElement('h2');heading.textContent=label;root.append(heading);
   if (!data[key].length) {const empty=document.createElement('p');empty.className='dim pad';empty.textContent='No games';root.append(empty);}
   for (const game of data[key]) {
    const row=document.createElement('div');row.className='card pad';
    const badge=document.createElement('small');badge.className='sports-badge';badge.textContent=game.league;row.append(badge);
    for (const team of [game.away,game.home]) {
     const line=document.createElement('div'), star=document.createElement('button');star.className='ghost';star.textContent=sportsTeams.includes(team)?'★':'☆';star.setAttribute('aria-label','Favorite '+team);star.setAttribute('aria-pressed',String(sportsTeams.includes(team)));star.onclick=async()=>{star.disabled=true;try {const next=sportsTeams.includes(team)?sportsTeams.filter(t=>t!==team):[...sportsTeams,team];const r=await fetch(B+'/api/sports/teams',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(next)});if(!r.ok)throw Error('Could not save favorites');await renderSports();}catch(e){toast(e.message);}finally{star.disabled=false;}};line.append(star,document.createTextNode(team));row.append(line);
    }
    const detail=document.createElement('p');detail.className='dim';detail.textContent=game.startLocal+' CT · '+game.status+(game.score?' · '+game.score:'');row.append(detail);
    if(game.notFound){const text=document.createElement('small');text.textContent='Channel not found';row.append(text);}
    for(const c of game.channels){const b=document.createElement('button');b.className='ghost';b.textContent=c.name;b.onclick=()=>pick(c.id,c.name);row.append(b);}root.append(row);
   }
  }
 } catch(e) {toast(e.message);} finally {sportsBusy=false;}
}
setInterval(()=>{if(view==='sports'&&!document.hidden)renderSports();},60000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&view==='sports')renderSports();});
