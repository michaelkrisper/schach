# Server

The app runs on the own server at https://schach.krisperapps.de/: Caddy in
front, a small Node service behind it. There is no database; nothing is stored.

| What | Where |
|---|---|
| Static files | `/srv/apps/schach/public`, served by Caddy |
| API | service `schach` (`node server/node.js`, port 8805, loopback only) |
| Secrets | `/etc/krisperapps/schach.env` (`KEY=value` lines) |
| Delivery | GitHub Actions on every merge to `main` (job "krisperapps.de"), secret `DEPLOY_SSH_KEY` |

```sh
systemctl status schach          # is the service running?
journalctl -u schach -n 50       # errors, including Gemini's answers
cat /srv/apps/schach/.version    # which version is live
```

## Requests

Caddy serves every file that exists under `public/` and passes everything else
to the Node service. That is `POST /api/recognize` and the start page `/`
(Caddy's `file` matcher does not match a directory, so Node answers `/` with
`public/index.html`, `Cache-Control: no-cache`); any other path answers 404, any
other method 405. The request body may be up to 7 MB (the function
accepts images up to 5 MB, sent as base64 inside JSON; the app scales photos to
1568 px first, usually well below 1 MB).

The access code and the limits are checked before the body is read. Per client
(`CF-Connecting-IP`, which Caddy sets; IPv6 by /64): ten wrong access codes lock it
out for an hour (429), and it gets 60 recognitions per hour (429). Four
recognitions run at once, further ones answer 503. The counters live in memory, so
a restart clears them. A model call is cut off after 75 s, all of them after 140 s.

## Secrets

| Name | Purpose | Missing |
|---|---|---|
| `GEMINI_API_KEY` | Google Gemini API key (free tier) | recognition answers 503 with a message, the rest of the app works |
| `ACCESS_CODE` | code the app asks for before it uploads a photo | recognition answers 503 (the unit sets `NODE_ENV=production`; without that it would be open to everyone) |

Set both in `/etc/krisperapps/schach.env`, then `systemctl restart schach`.
`DB_PATH` and `DATA_DIR` from the service unit are not used.

## Headers for static files

Static files never reach Node, so Caddy sets their headers. The site needs:

| Path | Header | Why |
|---|---|---|
| `/vendor/*` | `Cache-Control: public, max-age=86400` | engine (1.8 MB wasm) and chess.js change rarely |
| everything else (`/sw.js`, `/`, `/js/*`, ...) | `Cache-Control: no-cache` | a new version must be seen at once; the service worker does the caching |

```caddy
@vendor path /vendor/*
header @vendor Cache-Control "public, max-age=86400"
@fresh not path /vendor/* /api/*
header @fresh Cache-Control no-cache
```

`scripts/dev.mjs` sends the same headers locally. No cross-origin isolation
(COOP/COEP) is needed: Stockfish is the single-threaded build, on purpose, so
that the app also runs on iOS. `.wasm` must be served as `application/wasm`
(Caddy does that by itself).
