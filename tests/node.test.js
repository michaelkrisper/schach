import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, afterEach, before, test } from 'node:test';
import { clientKey, createApp } from '../server/node.js';

// The own server's entry point: real HTTP round trips through server/node.js.
const GEMINI = 'https://generativelanguage.googleapis.com/';
const realFetch = globalThis.fetch;
const apps = [];

async function start(env, now) {
  const app = createApp(env, now);
  apps.push(app);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${app.address().port}`;
}

function post(base, body, code = 'secret', ip = '198.51.100.1') {
  return realFetch(`${base}/api/recognize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-access-code': code, 'cf-connecting-ip': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

let base;
before(async () => {
  base = await start({ GEMINI_API_KEY: 'key', ACCESS_CODE: 'secret' });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
after(() => {
  for (const app of apps) app.close();
});

test('recognition over HTTP: access code, upload, placement', async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith(GEMINI));
    sent = init;
    const ranks = [
      'rnbqkbnr',
      'pppppppp',
      '........',
      '........',
      '........',
      '........',
      'PPPPPPPP',
      'RNBQKBNR',
    ];
    const text = JSON.stringify({ board_found: true, ranks, uncertain: ['e4'], note: '' });
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
  };
  // Larger than the usual 1 MB limit of such an entry: a photo has to fit.
  const image = 'A'.repeat(3 * 1024 * 1024);
  const res = await post(base, { image, mediaType: 'image/jpeg' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.placement, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
  assert.deepEqual(body.uncertain, ['e4']);
  assert.equal(sent.headers['x-goog-api-key'], 'key');
  assert.ok(sent.body.includes(image));

  assert.equal((await post(base, { image, mediaType: 'image/jpeg' }, 'nope')).status, 401);
});

test('without the secrets the endpoint answers with a clear error', async () => {
  const bare = await start({});
  const res = await post(bare, { image: 'aGVsbG8=', mediaType: 'image/jpeg' }, '');
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /nicht eingerichtet/);
});

test('an oversized body, an unknown path and a wrong method are refused', async () => {
  const big = await post(base, { image: 'A'.repeat(8 * 1024 * 1024), mediaType: 'image/jpeg' });
  assert.equal(big.status, 413);

  assert.equal((await realFetch(`${base}/api/nothing`)).status, 404);
  assert.equal((await realFetch(`${base}/js/app.js`)).status, 404);
  const get = await realFetch(`${base}/api/recognize`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await post(base, '{broken')).status, 400);
});

test('the start page is answered here, since the proxy passes directories on', async () => {
  const res = await realFetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(await res.text(), /<title>Schachfoto<\/title>/);
  const head = await realFetch(`${base}/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

// Past the access check and the limits, this body is refused by the function itself.
const BROKEN = '{broken';
const SECRETS = { GEMINI_API_KEY: 'key', ACCESS_CODE: 'secret' };

/** Sends only the headers of an upload: an answer can only come from a server that does not wait for the body. */
async function announce(base, length) {
  const req = httpRequest(`${base}/api/recognize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': length, 'x-access-code': 'nope' },
  });
  req.on('error', () => {});
  req.flushHeaders();
  const res = await new Promise((resolve) => req.on('response', resolve));
  req.destroy();
  return res;
}

test('a wrong access code is refused before the upload is read', { timeout: 5000 }, async () => {
  const limited = await start(SECRETS);
  const res = await announce(limited, 5 * 1024 * 1024);
  assert.equal(res.statusCode, 401);
  // The rest of a photo is discarded, so that a proxy can pass the refusal on ...
  assert.notEqual(res.headers.connection, 'close');
  // ... but nothing larger than a photo is taken in at all.
  assert.equal((await announce(limited, 50 * 1024 * 1024)).headers.connection, 'close');
});

test('ten wrong access codes lock a client out for an hour, others not', async () => {
  let time = 1_000_000;
  const limited = await start(SECRETS, () => time);
  const ip = '203.0.113.5';
  // The first upload of a fresh install carries no code: that is not a guess.
  for (let i = 0; i < 12; i++) assert.equal((await post(limited, BROKEN, '', ip)).status, 401);
  for (let i = 0; i < 10; i++) assert.equal((await post(limited, BROKEN, 'nope', ip)).status, 401);
  const locked = await post(limited, BROKEN, 'secret', ip);
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get('retry-after'), '3600');
  assert.match((await locked.json()).error, /Zugangscodes/);
  assert.equal((await post(limited, BROKEN, 'secret', '203.0.113.6')).status, 400);

  time += 60 * 60 * 1000;
  assert.equal((await post(limited, BROKEN, 'secret', ip)).status, 400);
});

test('IPv6 clients are counted per /64', async () => {
  const limited = await start(SECRETS);
  for (let i = 0; i < 10; i++) {
    assert.equal((await post(limited, BROKEN, 'nope', `2001:db8:1:2::${i + 1}`)).status, 401);
  }
  assert.equal((await post(limited, BROKEN, 'secret', '2001:db8:1:2:ffff::9')).status, 429);
  assert.equal((await post(limited, BROKEN, 'secret', '2001:db8:1:3::1')).status, 400);

  const key = (ip, remoteAddress) =>
    clientKey({ headers: { 'cf-connecting-ip': ip }, socket: { remoteAddress } });
  assert.equal(key('2001:0DB8:0:42:1:2:3:4'), key('2001:db8:0:42::'));
  assert.equal(key('::1'), '0:0:0:0');
  assert.equal(key('::ffff:192.0.2.7'), '192.0.2.7');
  assert.equal(key(undefined, '127.0.0.1'), '127.0.0.1');
});

test('in production a missing access code closes the endpoint', async () => {
  const open = await start({ GEMINI_API_KEY: 'key', NODE_ENV: 'production' });
  const res = await post(open, BROKEN, '');
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /Zugangscode/);
});

test('a client gets sixty recognitions per hour', async () => {
  let time = 1_000_000;
  const limited = await start(SECRETS, () => time);
  for (let i = 0; i < 60; i++) assert.equal((await post(limited, BROKEN)).status, 400);
  const res = await post(limited, BROKEN);
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /Stundenlimit/);
  assert.equal((await post(limited, BROKEN, 'secret', '198.51.100.2')).status, 400);
  time += 60 * 60 * 1000;
  assert.equal((await post(limited, BROKEN)).status, 400);
});

test('at most four recognitions run at once', async () => {
  const limited = await start(SECRETS);
  const waiting = [];
  globalThis.fetch = () => new Promise((resolve) => waiting.push(resolve));
  const photo = { image: 'aGVsbG8=', mediaType: 'image/jpeg' };
  const running = [1, 2, 3, 4].map(() => post(limited, photo));
  while (waiting.length < 4) await new Promise((resolve) => setTimeout(resolve, 5));

  const res = await post(limited, photo);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /viel los/);

  for (const resolve of waiting) resolve(new Response('bad request', { status: 400 }));
  for (const done of running) assert.equal((await done).status, 502);
  assert.equal((await post(limited, BROKEN)).status, 400);
});
