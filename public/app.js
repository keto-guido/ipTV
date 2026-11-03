'use strict';
const B = window.BASE, grid = document.getElementById('grid'), empty = document.getElementById('empty');
const tiles = new Map(); // id -> {el, video, hls, loaded}
const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
const native = !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl') && (isSafari || !(window.Hls && Hls.isSupported()));

async function api(p, opt) {
  const r = await fetch(B + p, Object.assign({ credentials: 'same-origin' }, opt));
  if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw 0; }
  return r.json();
}
const post = p => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

function attach(t, id) {
  const src = `${B}/hls/${id}/index.m3u8`;
  t.loaded = true;
  if (native) { t.video.src = src; t.video.play().catch(() => {}); return; }
  t.hls = new Hls({ liveSyncDurationCount: 3, manifestLoadingMaxRetry: 6, levelLoadingMaxRetry: 6, fragLoadingMaxRetry: 6 });
  t.hls.on(Hls.Events.ERROR, (e, d) => { if (d.fatal) detach(t); });
  t.hls.loadSource(src); t.hls.attachMedia(t.video);
  t.hls.on(Hls.Events.MANIFEST_PARSED, () => t.video.play().catch(() => {}));
}
function detach(t) {
  if (t.hls) { t.hls.destroy(); t.hls = null; }
  t.video.removeAttribute('src'); t.video.load(); t.loaded = false;
}

async function tick() {
  if (document.hidden) return;
  let s; try { s = await api('/api/status'); } catch { return; }
  document.getElementById('cog').hidden = !s.me.admin;
  const live = s.channels.filter(c => c.status !== 'down');
  for (const [id, t] of tiles) if (!live.find(c => c.id === id)) { detach(t); t.el.remove(); tiles.delete(id); }
  for (const c of live) {
    let t = tiles.get(c.id);
    if (!t) {
      const el = document.createElement('div'); el.className = 'tile';
      el.innerHTML = '<video playsinline muted autoplay controls></video><div class="tag"></div>';
      grid.appendChild(el);
      t = { el, video: el.querySelector('video') }; tiles.set(c.id, t);
      if (live.length === 1) t.video.muted = false;
    }
    const v = await post('/api/watch/' + c.id).catch(() => c);
    t.el.querySelector('.tag').textContent = v.ready ? '' : (v.status === 'backoff' ? '…' + v.retryIn + 's' : '…');
    if (v.ready && !t.loaded) attach(t, c.id);
    if (!v.ready && t.loaded && v.status !== 'running') detach(t);
  }
  grid.className = 'grid n' + Math.min(live.length, 4);
  empty.hidden = live.length > 0;
}
tick(); setInterval(tick, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
