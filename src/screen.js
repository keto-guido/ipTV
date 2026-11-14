'use strict';
const path = require('path');
const cp = require('child_process');
const ID = 'screen', NAME = 'McKinley Screen';
const isScreen = id => String(id) === ID;
let cached = null, pending = null;
// Local inputs only; kill our probe even when a capture driver hangs.
function probe(bin, args, timeout = 4000) {
  return new Promise(resolve => {
    let p, tail = '', done = false, timer;
    const finish = ok => { if (done) return; done = true; clearTimeout(timer); resolve({ ok, tail }); };
    try {
      p = cp.spawn(bin, ['-hide_banner', ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      timer = setTimeout(() => { try { p.kill(); } catch {} finish(false); }, timeout);
      p.stderr.on('data', d => { tail = (tail + d).slice(-16000); });
      p.once('error', () => finish(false));
      p.once('exit', code => finish(code === 0));
    } catch { finish(false); }
  });
}
function loopbackDevice(text) {
  for (const line of text.split('\n')) {
    const m = line.match(/"([^"\r\n]+)".*\(audio\)/i);
    if (m && !/microphone/i.test(m[1]) && /stereo mix|wave out mix|what u hear|loopback|cable output|sonar - stream/i.test(m[1])) return m[1];
  }
  return null;
}
function init(bin, log = () => {}) {
  if (pending) return pending;
  pending = (async () => {
    let grab = 'ddagrab';
    const dda = await probe(bin, ['-f', 'lavfi', '-i', 'ddagrab=output_idx=0:framerate=30', '-frames:v', '1', '-f', 'null', '-']);
    if (!dda.ok) {
      const gdi = await probe(bin, ['-f', 'gdigrab', '-framerate', '30', '-i', 'desktop', '-frames:v', '1', '-f', 'null', '-']);
      grab = gdi.ok ? 'gdigrab' : null;
    }
    cached = { grab, audioDevice: null, audio: 'silent AAC' };
    log('screen capture: ' + (grab || 'unavailable'));
    return cached;
  })();
  return pending;
}
async function probeAudio(bin, setting) {
  const audio = await probe(bin, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
  const trim = v => typeof v === 'string' ? v.trim() : '';
  const audioDevice = trim(process.env.SCREEN_AUDIO_DEVICE) || trim(setting) || loopbackDevice(audio.tail);
  return { audioDevice, audio: audioDevice || 'silent AAC' };
}
function setAudio(audio) { Object.assign(cached, audio); }
function classifyExit({ failures = 0, ranMs = 0 }) {
  const n = (ranMs > 60000 ? 0 : failures) + 1;
  return { action: n > 3 ? 'down' : 'retry', failures: n, reason: n > 3 ? 'capture failed' : 'capture failed, retrying' };
}
const normalize = ip => String(ip || '').trim().toLowerCase().replace(/^::ffff:/, '');
const isLoopback = req => ['127.0.0.1', '::1'].includes(normalize(req.socket && req.socket.remoteAddress));
function isLan(req) {
  const h = req.headers || {}, sock = normalize(req.socket && req.socket.remoteAddress);
  const local = ip => ['127.0.0.1', '::1'].includes(ip) || /^192\.168\.10\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(ip);
  if (!local(sock)) return false;
  // App Hub sets X-Forwarded-For to the real client; a proxy without it hides WAN clients behind a LAN address (best effort).
  const fwd = h['x-forwarded-for'] || h['x-real-ip'];
  return fwd ? local(normalize(String(fwd).split(',')[0])) : true;
}
function ffArgs({ encoder, tv, out, height = 720, grab = 'gdigrab', audioDevice = null }) {
  const h = height === 480 ? 480 : 720;
  const v = encoder === 'h264_nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-rc', 'cbr', '-bf', '0', '-rc-lookahead', '0', '-delay', '0', '-zerolatency', '1']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-bf', '0'];
  const br = h === 720 ? ['-b:v', '2200k', '-maxrate', '2500k', '-bufsize', '4400k'] : ['-b:v', '1200k', '-maxrate', '1400k', '-bufsize', '2400k'];
  const input = ['-hide_banner', '-nostats', '-loglevel', 'warning', '-fflags', 'nobuffer', '-flags', 'low_delay',
    ...(grab === 'ddagrab' ? ['-f', 'lavfi', '-i', 'ddagrab=output_idx=0:framerate=30:draw_mouse=1']
      : ['-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '1', '-thread_queue_size', '64', '-probesize', '1000000', '-analyzeduration', '0', '-i', 'desktop']),
    ...(audioDevice ? ['-f', 'dshow', '-thread_queue_size', '64', '-i', 'audio=' + audioDevice]
      : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'])];
  const download = grab === 'ddagrab' ? 'hwdownload,format=bgra,' : '';
  const scale = `${download}scale=-2:min(${h}\\,ih),format=yuv420p`;
  // Half-second IDRs and segments keep local screen capture close to live.
  const gop = [...(encoder === 'h264_nvenc' ? ['-no-scenecut', '1', '-forced-idr', '1'] : ['-sc_threshold', '0']),
    '-g', '15', '-force_key_frames', 'expr:gte(t,n_forced*0.5)'];
  const hls = ['-f', 'hls', '-hls_time', '0.5', '-hls_list_size', '4', '-hls_delete_threshold', '32', '-hls_flags', 'delete_segments+independent_segments+omit_endlist+program_date_time'];
  const phone = [...v, ...br, ...gop,
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
    ...hls,
    '-hls_segment_filename', path.join(out, 'seg_%05d.ts'), path.join(out, 'index.m3u8')];
  if (!tv) return [...input, '-map', '0:v:0', '-map', '1:a:0', '-sn', '-dn', '-vf', scale, ...phone];
  return [...input,
    '-filter_complex', `[0:v:0]${download}split=2[p][t];[p]${scale.slice(download.length)}[pv];[t]scale=-2:min(1080\\,ih),format=yuv420p[tv]`,
    '-map', '[pv]', '-map', '1:a:0', '-sn', '-dn', ...phone,
    '-map', '[tv]', '-map', '1:a:0', '-sn', '-dn',
    ...v, '-b:v', '7000k', '-maxrate', '8000k', '-bufsize', '14000k', ...gop,
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000',
    ...hls,
    '-hls_segment_filename', path.join(out, 'tv', 'seg_%05d.ts'), path.join(out, 'tv', 'index.m3u8')];
}
function nowPlaying(c) {
  return { id: ID, name: NAME, logo: null, group: 'Local', state: c.status, playing: !!c.ready, viewers: c.viewers, now: null, next: null };
}
module.exports = { nowPlaying, ID, NAME, isScreen, init, probeAudio, setAudio, result: () => cached, probe, loopbackDevice, ffArgs, classifyExit, isLan, isLoopback };
