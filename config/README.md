# config/

Both files here are **gitignored** and must never be committed.

| File | Contents | Written by |
|---|---|---|
| `secrets.env` | `IPTV_M3U_URL=<provider xmltv.php URL with username & password>` | you |
| `jwt_secret` | 64 lowercase hex chars, no newline. HMAC key = the hex string's UTF-8 bytes. Shared with the NAS dashboard. | NAS bot |

Example `secrets.env`:

```
IPTV_M3U_URL=http://provider.example:8080/xmltv.php?username=USER&password=PASS
```

The app derives host, username and password from that URL in memory. If `jwt_secret` is missing the app still starts but rejects every request with 401 until it appears (it is re-read automatically).
