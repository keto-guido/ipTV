# Brief: 1080p TV rendition (for the tv-sync clients)

Approved by Eric: "Yes, OK to add the 1080p re-encoded TV output to the ipTV app; phone stream stays the same". Scope is ONLY that. This repo is PUBLIC: never commit secrets (config/secrets.env, config/jwt_secret, config/local.json, data/, logs).

## Goal
From the SAME single upstream per channel (one ffmpeg process, one provider connection, decode once), produce two outputs:
1. **Phone output (unchanged)**: exactly the current 720p (or 480p setting) encode, same codec/rate-control/bitrate/GOP/force_key_frames/audio/HLS options, same paths (`<hls>/<id>/index.m3u8`, `seg_%05d.ts`) and same playlist. The only permitted change is moving the scale filter from `-vf` into a `-filter_complex` `split` branch; the resulting args for that output must be otherwise identical.
2. **TV output (new)**: 1080p (`scale=-2:min(1080\,ih)`, yuv420p) H.264 via the same encoder (h264_nvenc preset p4, CBR), about 7 Mbps (`-b:v 7000k -maxrate 8000k -bufsize 14000k`), **keyframe every 1 s** (GOP = output fps; use `-force_key_frames expr:gte(t,n_forced*1)` and `-g` = fps, `-sc_threshold 0`/`-no-scenecut 1` where applicable), **2 s segments** (`-hls_time 2`, list size ~8), `-hls_flags delete_segments+independent_segments+omit_endlist+program_date_time` (EXT-X-PROGRAM-DATE-TIME stamped by McKinley's clock), AAC 48 kHz stereo 160k. Path: `<hls>/<id>/tv/index.m3u8` + `tv/seg_%05d.ts`, served at `/tv/hls/<id>/tv/index.m3u8` and `/tv/hls/<id>/tv/seg_NNNNN.ts` with the SAME JWT auth and cache headers as the existing HLS routes. Accessing the TV playlist counts as viewer activity the same way the phone playlist does (so idle-stop logic still works), but do not change idle-stop timings.

## Config
- Flag `tvRendition` (default **true**) in the existing settings mechanism (DEFAULTS/settings file), optionally overridable via env `TV_RENDITION=0`. When false, ffmpeg args must be exactly the current ones.
- No change to phone UI, endpoints, or behavior. Do not add UI except optionally a read-only field in /api/status (e.g. `tv: true|false` per channel) - optional.

## Must NOT change
Provider-safety logic: upstream cap (maxStreams, currently 1), one upstream per channel, backoff with jitter, circuit breaker, idle stop, 30 s restart debounce, VLC User-Agent, rate-limited playlist/EPG refresh, redaction of URLs/credentials in logs. Never expose upstream URLs to clients. Base path /tv and auth contract unchanged.

## Graceful fallback (NVENC limits / GPU load)
- At startup, extend the existing local-only encoder probe (lavfi, no provider traffic): test two simultaneous NVENC encodes (1080p + 720p in one ffmpeg via split). If it fails, TV rendition is disabled for this process (log it) and the phone pipeline is exactly as today.
- At runtime, if an ffmpeg process with the TV output exits with an NVENC/encoder/session error (e.g. `OpenEncodeSessionEx`, `No capable devices`, `out of memory`), set TV rendition off for the rest of the process lifetime and let the EXISTING restart/backoff path restart the channel phone-only. Do not add any extra provider connections or faster restarts than the existing logic allows.
- libx264 fallback encoder: if the phone encoder is libx264 (no NVENC), keep TV rendition OFF (CPU would not cope).

## Testing (no provider contact)
- Do NOT start provider streams. Test the ffmpeg arg builder with unit tests and with a local lavfi source (`testsrc2` 1920x1080@59.94 + sine) replacing the input, writing to a temp dir outside the repo: verify phone playlist/segments look as before (720p, 3 s), TV playlist has EXT-X-PROGRAM-DATE-TIME, 1080p segments, keyframes every 1 s (ffprobe `-skip_frame nokey -show_entries frame=pts_time`).
- Add a test that with `tvRendition=false` the args equal the previous args exactly (snapshot).
- ffmpeg/ffprobe: portable 7.0.2 at C:\Users\ericm\AppData\Local\ffmpeg-7.0\ffmpeg-7.0.2-essentials_build\bin.
- Do NOT restart or stop the running production server (node src\server.js on port 8090) and do not kill ffmpeg processes you did not start.

## Deliver
- Small, readable diff in src/channels.js (+ server.js route for /hls/<id>/tv/*), README section "TV rendition".
- Commit in logical chunks; `git push origin main`. Print a summary of the diff and test results at the end.
