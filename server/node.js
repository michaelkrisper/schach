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
import { onRequestPost as recognize } from '../functions/api/recognize.js';

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

const ROUTES = { '/': { GET: startPage, HEAD: startPage }, '/api/recognize': { POST: recognize } };

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

async function handle(incoming, env) {
  const route = ROUTES[new URL(incoming.url, 'http://localhost').pathname];
  if (!route) return json({ error: 'Nicht gefunden.' }, 404);
  const handler = route[incoming.method];
  if (!handler)
    return json({ error: 'Methode nicht erlaubt.' }, 405, { allow: Object.keys(route).join(', ') });
  const request = await toRequest(incoming);
  if (!request) return json({ error: 'Bild ist zu groß.' }, 413);
  return handler({ request, env });
}

/** `env` carries the secrets (GEMINI_API_KEY, ACCESS_CODE); both may be missing. */
export function createApp(env = process.env) {
  return createServer(async (incoming, outgoing) => {
    try {
      const response = await handle(incoming, env);
      // An upload that was cut off at the limit is not read to its end.
      if (response.status === 413) outgoing.setHeader('connection', 'close');
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(error);
      if (!outgoing.headersSent)
        outgoing.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      outgoing.end('{"error":"Interner Fehler."}');
    }
  });
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
