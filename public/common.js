'use strict';
const B = window.BASE, $ = id => document.getElementById(id);
async function api(p, body) {
  const o = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(B + p, o);
  if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('auth'); }
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hm = t => new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
// now/next line for a channel row
function nn(e) {
  if (!e) return '';
  const [a, b] = e;
  return (a ? `<b>${esc(a[2])}</b>` : '') + (b ? ` <span class="dim">· ${hm(b[0])} ${esc(b[2])}</span>` : '');
}
let FAV = new Set();
async function loadFavs() { const f = await api('/api/favorites'); FAV = new Set(f.map(c => c.id)); return f; }
async function star(id) { const on = !FAV.has(id); FAV = new Set(await api('/api/favorites', { id, on })); return on; }
async function nowNext(ids) { return ids.length ? api('/api/epg/now?ids=' + ids.join(',')) : {}; }
