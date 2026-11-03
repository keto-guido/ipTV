# ipTV relay

A small, zero-dependency Node.js app that relays an Xtream-Codes IPTV channel to the household's browsers and iPhones.
One upstream connection per active channel (shared by every viewer) is transcoded by ffmpeg (NVENC, libx264 fallback) to a rolling HLS playlist. Access is gated by the NAS dashboard's `msv_session` JWT.

- `/tv/` – viewer: plays the active channel(s); multiview grid when more than one is active. Native HLS on Safari/iOS, vendored hls.js elsewhere.
- `/tv/admin` – search/filter channels by name or category, pick channel(s) up to the cap, stop, settings (max concurrent, 720p/480p, idle timeout), status and viewer count, rate-limited list refresh.

## Requirements
- Node.js ≥ 20 (no npm dependencies; `hls.js` 1.5 is vendored in `public/vendor/`)
- ffmpeg on PATH (NVIDIA GPU for `h264_nvenc`; otherwise libx264 veryfast is used automatically)

## Setup
1. `config/secrets.env` – one line `IPTV_M3U_URL=<provider xmltv.php URL with username/password>` (see `config/README.md`).
2. `config/jwt_secret` – written by the NAS bot. Until it exists the app runs but answers 401 to everything.
3. Start: `npm start` (or double-click `start-tv.cmd`). Listens on `0.0.0.0:8090`, base path `/tv`.

Gitignored: `config/secrets.env`, `config/jwt_secret`, `data/` (cache, settings, selection), `hls/` (segments), `node_modules/`, `*.log`, `.env`.

### Environment overrides
| Var | Default |
|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8090` |
| `BASE_PATH` | `/tv` |
| `LOGIN_PATH` | `/login` |
| `JWT_SECRET_FILE` | `config/jwt_secret` |
| `SECRETS_FILE` | `config/secrets.env` |
| `FFMPEG` | `ffmpeg` |
| `DEV_AUTH` | off – see below |

## Auth
The NAS dashboard is the only login and reverse-proxies `https://mersinoserver.ddns.net/tv/*` → `http://192.168.10.208:8090/tv/*` (prefix kept).
Every request – pages, API, `.m3u8` and segments – must carry cookie `msv_session`, an HS256 JWT `{sub, name, roles, iat, exp}`.
The signature is verified with Node `crypto` (constant-time compare; any `alg` other than `HS256` is rejected) and `exp` is checked each time.
If the cookie is absent, the NAS proxy's `X-Apphub-Token` header (5-min HS256 JWT, same key) is accepted, additionally requiring `iss=apphub` and `aud=tv`.
Roles: `tv` = watch, `tv-admin` = watch + admin. Unauthenticated HTML → `302 /login?next=<path>`; API/media → `401`. Proxy headers such as `X-Apphub-User` are ignored.

**Local dev:** `npm run dev` binds to `127.0.0.1` with `DEV_AUTH=1` and skips auth. `DEV_AUTH` is ignored unless `HOST=127.0.0.1`. Off by default.
`node scripts/mint-token.js <secretFile> [roles] [ttl]` mints a test token.

## Provider safety
- **Concurrency cap** (default 1, admin setting up to 4). Exactly one ffmpeg/upstream per active channel, shared by all viewers.
- **Channel list** (`get_live_categories`, `get_live_streams`) cached in `data/channels.json`; fetched only if missing or >12 h old. Manual refresh limited to once per 10 min. EPG is not fetched in v1.
- **Reconnects**: exponential backoff from 5 s doubling to 5 min with ±20 % jitter, max 6 retries, then the channel is marked `down` until an admin re-selects it. Output mentioning 401/403/429/509 marks it `down` immediately. ffmpeg's own reconnect is not used.
- **Idle stop**: the upstream is closed when nobody has fetched the playlist/segments (or pinged from the viewer) for the idle timeout (default 3 min). It restarts on demand when a viewer returns, still within the cap.
- **User-Agent** `VLC/3.0.20 LibVLC/3.0.20` on API calls and ffmpeg.
- Upstream URLs/credentials never reach clients; all logs pass through a redactor.
- Channels are only probed when an admin selects them. The NVENC check at startup uses a local test pattern (no provider traffic).

## Transcode
`h264_nvenc` (p4, CBR) scaled to 720p ≈2.2 Mbps (or 480p ≈1.2 Mbps), never upscaled; AAC 128k stereo; HLS 3 s segments, 6-segment rolling list with `delete_segments`, written to `hls/<channelId>/`.

## Layout
```
src/server.js     HTTP server, routing, auth gate
src/auth.js       HS256 JWT verification, secret file reload
src/config.js     settings, credential derivation, log redaction
src/provider.js   Xtream API + channel-list cache
src/channels.js   ffmpeg lifecycle, cap, backoff, circuit breaker, idle stop
public/           viewer + admin UI, vendored hls.js
scripts/          dev launcher, test-token minter
```

## Known issue: NVENC on this PC
ffmpeg 9.x requires NVIDIA driver = 610 for NVENC (API 13.1). McKinley's GTX 1060 runs driver 560.94, and Pascal GPUs don't get 610+ drivers, so the app detects this at startup and uses libx264 `veryfast` (~2�5 % total CPU for one 720p channel on this machine). To use the GPU, point `FFMPEG` at an older ffmpeg build (7.x, NVENC API 12) � e.g. `set FFMPEG=C:\tools\ffmpeg7\bin\ffmpeg.exe`.
