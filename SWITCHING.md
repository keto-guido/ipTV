Switch notifications
====================

`/api/status` and SSE `state` expose `live.switchedAt` (server milliseconds),
`live.switchSeq`, and `live.switchPdt`. Boundary fields are null until the new
source's first segment is published. SSE `switching` sends `id`, `name`, a local
`logo` path, and these fields immediately on selection/replacement, before waiting
for the old process to stop. It sends updates as boundaries become available.

The top-level boundary describes the **TV** playlist. Phone and TV writers have
independent sequence numbers and may publish at different times. The additional
`phoneSwitch: {switchSeq, switchPdt}` describes the phone playlist when available;
the browser viewer uses this boundary. Consumers must not compare TV sequences
with phone fragments. Boundary updates retain the original `switchedAt`.

The viewer shows a small switch notice until its played fragment reaches the
phone boundary. Native players use their playback date when supported. A 15-second
deadline clears the notice when playback timing is unavailable. State reconnects
and polling recover the current switch without extending that deadline.

Run `npm run test:light` for mocked and local-file tests. The default `npm test`
also includes media integration and soak tests and is unsuitable for light checks.
