// Entry point on the own server: plain Node in front of the one function in
// functions/. Only requests for files that do not exist in public/ arrive here;
// the web server in front (Caddy; scripts/dev.mjs locally) serves public/ itself.
// The one exception is "/": Caddy passes directories on, so the start page is
// answered here.
//
//   PORT=8805 node server/node.js
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { onRequestPost as recognize, refuseAccess } from '../functions/api/recognize.js';

// Workers-only API that the function compares the access code with.
crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(a, b);

// The function accepts images up to 5 MB; as base64 inside JSON that is 6.7 MB.
// The app itself sends far less (1568 px JPEG, usually below 1 MB).
const MAX_BODY = 7 * 1024 * 1024;

const INDEX = new URL('../public/index.html', import.meta.url);

function startPage() {
  return new Response(readFileSync(INDEX), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

const HOUR_MS = 60 * 60 * 1000;
const MAX_WRONG_CODES = 10;
// Every recognition costs free-tier quota: a leaked code must not burn it all.
const MAX_RECOGNITIONS = 60;
const MAX_CONCURRENT = 4;
// The limit is reached as soon as an upload starts, so a stalled one must end.
const REQUEST_TIMEOUT_MS = 120_000;

/** Counts per client in a fixed window. In memory: a restart forgets them. */
function createLimiter(max, now) {
  const windows = new Map();
  const current = (key) => {
    const entry = windows.get(key);
    if (entry && entry.end <= now()) windows.delete(key);
    return windows.get(key);
  };
  return {
    /** Seconds until the client may try again, 0 when it is not blocked. */
    blockedFor(key) {
      const entry = current(key);
      return entry && entry.count >= max ? Math.ceil((entry.end - now()) / 1000) : 0;
    },
    hit(key) {
      const entry = current(key);
      if (entry) return void entry.count++;
      if (windows.size >= 10_000) for (const k of [...windows.keys()]) current(k);
      windows.set(key, { count: 1, end: now() + HOUR_MS });
    },
  };
}

/**
 * Who is asking: the address the proxy saw (it sets CF-Connecting-IP itself, a
 * client cannot), IPv6 by /64 since one client owns a whole such network.
 */
export function clientKey(incoming) {
  const ip = String(incoming.headers['cf-connecting-ip'] ?? incoming.socket.remoteAddress ?? '');
  if (!ip.includes(':')) return ip;
  if (ip.includes('.')) return ip.slice(ip.lastIndexOf(':') + 1);
  const [head, tail] = ip.split('::').map((part) => (part ? part.split(':') : []));
  const groups = tail ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  return groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(':');
}

function tooMany(error, seconds) {
  return json({ error }, 429, { 'retry-after': String(seconds) });
}

/** The recognition behind its limits; everything is decided before the body is read. */
function limitedRecognize(now) {
  const wrongCodes = createLimiter(MAX_WRONG_CODES, now);
  const recognitions = createLimiter(MAX_RECOGNITIONS, now);
  let running = 0;
  return async (incoming, env) => {
    const key = clientKey(incoming);
    // Also with the right code: otherwise guessing could simply go on.
    let wait = wrongCodes.blockedFor(key);
    if (wait) return tooMany('Zu viele falsche Zugangscodes. Bitte in einer Stunde nochmal versuchen.', wait);
    const code = incoming.headers['x-access-code'];
    const refusal = await refuseAccess(code, env);
    if (refusal) {
      // The app's first upload carries no code yet; that is not a guess.
      if (refusal.status === 401 && code) wrongCodes.hit(key);
      return refusal;
    }
    wait = recognitions.blockedFor(key);
    if (wait) return tooMany('Stundenlimit für Erkennungen erreicht. Bitte später nochmal versuchen.', wait);
    if (running >= MAX_CONCURRENT)
      return json({ error: 'Gerade viel los, bitte gleich nochmal versuchen.' }, 503, {
        'retry-after': '10',
      });
    recognitions.hit(key);
    running++;
    try {
      const request = await toRequest(incoming);
      if (!request) return json({ error: 'Bild ist zu groß.' }, 413);
      return await recognize({ request, env });
    } finally {
      running--;
    }
  };
}

function json(body, status, headers = {}) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

async function readAll(incoming) {
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Turns Node's request into the Request the function expects. Null: body too large. */
export async function toRequest(incoming) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const proto = headers.get('x-forwarded-proto') ?? 'http';
  const url = `${proto}://${headers.get('host') ?? 'localhost'}${incoming.url}`;
  const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
  const body = hasBody ? await readAll(incoming) : undefined;
  if (body === null) return null;
  return new Request(url, { method: incoming.method, headers, body });
}

async function handle(routes, incoming, env) {
  const route = routes[new URL(incoming.url, 'http://localhost').pathname];
  if (!route) return json({ error: 'Nicht gefunden.' }, 404);
  const handler = route[incoming.method];
  if (!handler)
    return json({ error: 'Methode nicht erlaubt.' }, 405, { allow: Object.keys(route).join(', ') });
  return handler(incoming, env);
}

/**
 * `env` carries the secrets (GEMINI_API_KEY, ACCESS_CODE); both may be missing.
 * `now` is the clock of the rate limits.
 */
export function createApp(env = process.env, now = Date.now) {
  const routes = {
    '/': { GET: startPage, HEAD: startPage },
    '/api/recognize': { POST: limitedRecognize(now) },
  };
  const app = createServer(async (incoming, outgoing) => {
    try {
      const response = await handle(routes, incoming, env);
      // The rest of a refused upload is discarded by Node, unbuffered. Closing at once
      // would be cheaper, but then the proxy at times answers 502 instead of passing
      // the refusal on (measured with Caddy), and the app's first upload is always
      // refused: it has no access code yet. So close only where no legitimate client
      // gets to: a body that is, or may become, larger than the limit.
      const rest = Number(incoming.headers['content-length']);
      if (!(incoming.complete || rest <= MAX_BODY)) outgoing.setHeader('connection', 'close');
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(error);
      if (!outgoing.headersSent)
        outgoing.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      outgoing.end('{"error":"Interner Fehler."}');
    }
  });
  app.requestTimeout = REQUEST_TIMEOUT_MS;
  return app;
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8805);
  const app = createApp();
  // Loopback only: the proxy is the one way in.
  app.listen(port, '127.0.0.1', () => {
    const missing = ['GEMINI_API_KEY', 'ACCESS_CODE'].filter((name) => !process.env[name]);
    console.info(
      `schach: http://127.0.0.1:${port}${missing.length ? `, not set: ${missing.join(', ')}` : ''}`,
    );
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.close(() => process.exit(0)));
}
