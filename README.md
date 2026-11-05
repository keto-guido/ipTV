# ipTV relay

A small, zero-dependency Node.js app that relays an Xtream-Codes IPTV channel to the household's browsers and iPhones.
One upstream connection per active channel (shared by every viewer) is transcoded by ffmpeg (NVENC, libx264 fallback) to a rolling HLS playlist, and two constant live playlists follow whichever channel is on. Access is gated by the NAS dashboard's `msv_session` JWT.

- `/tv/` – viewer: one player attached once to the live playlist, so channel changes happen inside the stream; multiview grid when more than one is active. Native HLS on Safari/iOS, vendored hls.js elsewhere.
- `/tv/guide` – channel guide grid (time across, channels down), defaults to your favorites, category filter, paged 30 rows at a time.
- `/tv/admin` – search/filter channels by name or category, pick channel(s) up to the cap, stop, settings (max concurrent, 720p/480p, idle timeout), status and viewer count, rate-limited list refresh.

## Requirements
- Node.js ≥ 20 (no npm dependencies; `hls.js` 1.5 is vendored in `public/vendor/`)
- ffmpeg on PATH (NVIDIA GPU for `h264_nvenc`; otherwise libx264 veryfast is used automatically)

## Setup
1. `config/secrets.env` – one line `IPTV_M3U_URL=<provider xmltv.php URL with username/password>` (see `config/README.md`).
2. `config/jwt_secret` – written by the NAS bot. Until it exists the app runs but answers 401 to everything.
3. Start: `npm start` (or double-click `start-tv.cmd`). Listens on `0.0.0.0:8090`, base path `/tv`.

Gitignored: `config/secrets.env`, `config/jwt_secret`, `data/` (cache, settings, selection, slate), `hls/` (segments), `node_modules/`, `*.log`, `.env`.

### Environment overrides
| Var | Default |
|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8090` |
| `BASE_PATH` | `/tv` |
| `LOGIN_PATH` | `/login` |
| `JWT_SECRET_FILE` | `config/jwt_secret` |
| `SECRETS_FILE` | `config/secrets.env` |
| `FFMPEG` | `ffmpeg` (used if `config/local.json` has no `ffmpegPath`) |
| `TV_RENDITION` | on; `0` turns the TV rendition off (wins over the setting) |
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
- **Channel list** (`get_live_categories`, `get_live_streams`) cached in `data/channels.json`; fetched only if missing or >12 h old. Manual refresh limited to once per 10 min.
- **Reconnects**: exponential backoff from 5 s doubling to 5 min with ±20 % jitter, max 6 retries (3 for a 403), then the channel is marked `down` with a reason in `/api/status` until someone retries it (admin select, or `POST /api/retry/<id>` for any viewer; restarts stay debounced to once per 30 s). A 401/429/509 marks it `down` immediately, and so does a 403 if the stream never produced a segment; a 403 after segments were produced goes through the backoff. A run longer than 60 s resets the retry count, so a run that plays past 60 s and then gets a 403 is counted separately: 5 such restarts in a rolling 30 min are allowed and the next one marks the channel `down`, with the same retry path. ffmpeg's own reconnect is not used.
- **Idle stop**: the upstream is closed when nobody has fetched the playlist/segments (or pinged from the viewer) for the idle timeout (default 3 min). It restarts on demand when a viewer returns, still within the cap.
- **User-Agent** `VLC/3.0.20 LibVLC/3.0.20` on API calls and ffmpeg.
- Upstream URLs/credentials never reach clients; all logs pass through a redactor.
- Channels are only probed when an admin selects them. The NVENC check at startup uses a local test pattern (no provider traffic).

## Guide (EPG) and favorites
- The XMLTV URL in `secrets.env` is fetched **at most every 12 h** (checked every 30 min, only when the cache is stale, so not on every start), plus an admin manual refresh limited to **once per hour** (▦↻ on the admin page). `EPG_AUTO=0` disables scheduled fetches.
- The download is streamed (gzip-aware, also sniffs `.gz` bodies) and parsed by a small hand-rolled streaming parser. Only programmes for channels in `get_live_streams` (`epg_channel_id`) within **now−2 h … now+24 h** are kept, as compact `[start, stop, title, desc≤140]` arrays in `data/epg.json`.
- Clients are served only from that cache (`/api/epg/now`, `/api/epg/range`); the provider is never proxied.
- Favorites are per user (JWT `sub`) in `data/favorites.json`. Any `tv` user can star channels (★ drawer on the viewer, guide, admin list). The admin list has a ★ filter to serve favorites quickly.
- Browsing the guide or favorites never opens a stream or contacts the provider; only an admin selecting a channel does.

## API (under `/tv`, all require auth)
| Endpoint | tv | tv-admin |
|---|---|---|
| `GET /api/status`, `GET /api/events`, `POST /api/watch/:id` | ✓ | ✓ |
| `GET/POST /api/favorites`, `GET /api/categories`, `GET /api/lineup?cat=`, `GET /api/epg/now?ids=`, `GET /api/epg/range?ids=&from=&hours=` | ✓ | ✓ |
| `GET /api/channels`, `GET /api/search?q=&cat=&offset=&limit=` (admin list uses this, 50 per page), `POST /api/refresh`, `GET /api/epg/info`, `POST /api/epg/refresh`, `GET/POST /api/settings`, `POST /api/select`, `POST /api/stop` | | ✓ |

## Transcode
`h264_nvenc` (p4, CBR) scaled to 720p ≈2.2 Mbps (or 480p ≈1.2 Mbps), never upscaled; AAC 128k stereo; HLS 1 s segments with an IDR every second, 6-segment rolling list with `delete_segments`, written to `hls/<channelId>/`.

## Live playlists
Constant URLs that never change across channel switches. Clients attach once and stay attached:

| Rendition | Playlist | Follows |
|---|---|---|
| Phone | `/tv/hls/live/phone/index.m3u8` | the channel's phone output |
| TV | `/tv/hls/live/tv/index.m3u8` | the channel's TV output, or its phone output if the channel runs without one |

- **Which channel:** the latest one selected (`live` in `/api/status`, kept across restarts). If it is stopped, the previous one still selected takes over. With a cap above 1 the other channels are still reachable on their per-channel paths, which work exactly as before.
- **Source:** `src/live.js` polls the running ffmpeg playlist every 250 ms, hard-links each finished segment into `hls/live/<rendition>/` and lists it under its own number. The playlist itself is built in memory (`src/playlist.js`).
- **Tags:** `EXT-X-MEDIA-SEQUENCE` only goes up, also across a server restart (it is seeded from the clock). `EXT-X-DISCONTINUITY` marks every source change: channel, new ffmpeg run of the same channel, slate, or a segment missed inside a run. `EXT-X-DISCONTINUITY-SEQUENCE` counts those that have scrolled off. Every segment has `EXT-X-PROGRAM-DATE-TIME`.
- **Retention:** segments stay fetchable for 14 segments after leaving the 6-segment list. ffmpeg's `delete_segments` and the directory cleanup on a switch cannot affect them, because the hard links are separate names for the data. ipTV deletes them when they age out.
- **Slate:** while nothing is running, during a switch until the new first segment exists, or if a running source leaves the playlist more than 1.5 s behind the clock, the playlist carries black and silent H.264/AAC segments, so it stays valid and moving. The 60 s loop is generated with local ffmpeg lavfi on first need and cached in `data/slate/` (720p or 480p to match the setting, 1080p for TV). Its timestamps are continuous, so it adds one more discontinuity each time it loops. On the very first start, until the slate exists, an empty playlist answers `503` with `Retry-After: 1`.
- **Auth:** the same JWT check as the other `/hls` routes, on every playlist and segment.
- **Idle:** only segment fetches count as viewer activity, and only on a running live channel. Playlist requests do not, so polling a playlist with nothing watching lets the channel idle-stop. No live request starts a channel: that still takes `POST /api/watch/<id>`, debounced as before.

Notes for clients:
- PDT is one continuous timeline per rendition: every segment's PDT is exactly the previous PDT plus the previous `EXTINF`, across discontinuities and slate too. It stays near this PC's clock because slate fills any shortfall, normally within about 2 s. It is never pulled back, so a provider that bursts its first seconds stays that far ahead until slate next has to wait for the clock. A server restart starts a new timeline from the clock. The two renditions are not guaranteed to match each other to the frame.
- `EXT-X-TARGETDURATION` is normally 1. If a longer segment is listed it rises to cover that segment, then falls back, as ffmpeg's own playlists do.

## Events
`GET /tv/api/events` is a server-sent event stream. Each `state` event carries the whole state, once on connect and again on each change (checked every 500 ms), with a `: ping` comment every 15 s:

```json
{ "live": { "id": "123", "name": "Channel", "slate": false },
  "channels": [{ "id": "123", "name": "Channel", "status": "running", "ready": true, "tv": true }] }
```

`live` is `null` when no channel is selected, `slate` says the phone playlist is currently on slate, and `reason` appears on a channel that is down or backing off.

Auth is the normal cookie or `X-Apphub-Token`, which same-origin `EventSource` sends by itself, so no token goes in a URL. The stream ends when the JWT expires and the client's reconnect is checked afresh. Limits are 8 streams per user and 64 in total, then `429`. The viewer also polls every 20 s as a fallback.

## TV rendition
For the tv-sync clients, the same ffmpeg process (one provider connection, decoded once) also writes a 1080p output through a `split` filter.

| | Phone | TV |
|---|---|---|
| Playlist | `/tv/hls/<id>/index.m3u8` | `/tv/hls/<id>/tv/index.m3u8` |
| Video | 720p/480p, 2.2/1.2 Mbps | up to 1080p (never upscaled), 7 Mbps CBR, `-maxrate 8000k -bufsize 14000k` |
| Keyframes | IDR every 1 s | IDR every 1 s |
| Segments | 1 s, 6 in the list | 1 s, 6 in the list |
| Audio | AAC 128k | AAC 160k |
| `EXT-X-PROGRAM-DATE-TIME` | yes | yes |

- **Routes:** same JWT auth and cache headers as the phone HLS routes. Fetching TV files counts as viewer activity, so idle stop behaves the same; if nobody is watching, the channel stops as usual.
- **Status:** `tv: true|false` per channel in `/api/status` says whether the running ffmpeg has the TV output. The playlist can still 404 for a few seconds after start, as the phone one does.
- **Off switch:** `tvRendition` in `data/settings.json` (default `true`, also accepted by `POST /api/settings`) or env `TV_RENDITION=0`. Applies at the next channel start. When off, ffmpeg gets just the phone output (`test/tv.test.js` holds the snapshot).
- **Fallback:** the startup self-test also runs a 720p + 1080p NVENC pair on a local test pattern. If it fails, or a running ffmpeg with the TV output dies with an encoder/NVENC session error, TV stays off until the server restarts and channels run phone-only. The channel comes back through the normal backoff, with no extra or faster restarts. With libx264 the TV rendition is always off, because the CPU would not cope.

Notes for clients:
- These are the per-channel playlists. They restart with every channel start; the live playlists above are the stable ones.
- `-g` is 60 rather than the source fps, because reading the fps would mean probing upstream. It is only a ceiling for inputs up to 60 fps; the forced keyframes set the real 1 s GOP (measured at 59.94, 29.97 and 25 fps).
- Program date times come from ffmpeg: this PC's clock at process start (whole seconds) plus segment durations. They agree for everyone reading the playlist, but carry a constant offset per ffmpeg run (about 0.7 s from real time in testing) and restart after a channel restart.
- ffmpeg 7 writes the offset without a colon (`2026-11-03T18:00:59.397-0600`). V8's `Date.parse` accepts this, so Node and Chromium are fine; other client runtimes are untested.

## Tests
`npm test` runs without the provider, and redirects data and HLS paths to a temp dir, so it is safe beside a running server. `test/lavfi.test.js` does real NVENC encodes of a local test pattern (about 45 s, skipped without NVENC). `test/live-integration.test.js` runs two channel switches through the real server and ffmpeg on local test patterns on a temp port (about 35 s, libx264 only, so it uses no NVENC session), with a client polling the live playlist throughout.

## Layout
```
src/server.js     HTTP server, routing, auth gate
src/auth.js       HS256 JWT verification, secret file reload
src/config.js     settings, credential derivation, log redaction
src/provider.js   Xtream API + channel-list cache
src/epg.js        streaming XMLTV fetch/parse + guide cache
src/channels.js   ffmpeg lifecycle, cap, backoff, circuit breaker, idle stop
src/live.js       live playlists: follows the current channel, generates the slate
src/playlist.js   one live playlist: sequence, discontinuities, PDT, segment retention
src/events.js     server-sent events
public/           viewer + admin UI, vendored hls.js
scripts/          dev launcher, test-token minter
test/             node:test suites (mocked ffmpeg, routes, live playlists, events, real ffmpeg on lavfi)
```

## NVENC on this PC
ffmpeg 9.x needs NVIDIA driver ≥ 610 for NVENC; McKinley's GTX 1060 (driver 560.94) can't get that. The app therefore uses a portable ffmpeg 7.0.2 (NVENC API 12) configured in the gitignored `config/local.json`:

```json
{ "ffmpegPath": "C:\\Users\\ericm\\AppData\\Local\\ffmpeg-7.0\\ffmpeg-7.0.2-essentials_build\\bin\\ffmpeg.exe" }
```

Resolution order: `config/local.json` `ffmpegPath` → `FFMPEG` env → `ffmpeg` on PATH. A startup self-test (local test pattern, no provider traffic) picks `h264_nvenc`, else libx264 `veryfast`.

## Viewer heartbeats
The viewer posts `/api/watch/<id>` on every status update: when an event arrives, and at least every 20 s. This only bumps last-seen for channels an admin has selected (others → 404); a running upstream is never restarted or duplicated, and restarting an idle-stopped selected channel is debounced to at most once per 30 s.

While a channel is playing and the page is visible, the viewer also posts `/api/watch/<id>?keepalive=1` every 60 s. That only extends the idle timer of a running upstream and never starts one.

## Sports Today

The Sports tab shows today's ESPN games in Chicago time: Live now, Later, and Final. Tap a channel to use the normal playback controls; stars save team favorites per user (Chicago teams by default). Channel matching reads the local channel and EPG caches only. ESPN scoreboards are cached for ten minutes; unavailable feeds retain stale results. A missing channel is shown explicitly.

`sportsListRefresh` (default true; set false in `data/settings.json` to disable) runs provider list refreshes at 06:00, 12:00, and 17:00 America/Chicago. It skips active streams and concurrent refreshes, and uses the existing rate-limited refresh path. Sports itself never starts a stream. Run the lightweight feature tests with `node --test test/sports.test.js`.

Sports matching checks run with `npm test` (mocked ESPN, no encoder processes). Media integration tests are separate under `npm run test:media`.
