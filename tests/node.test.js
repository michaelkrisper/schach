import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { createApp } from '../server/node.js';

// The own server's entry point: real HTTP round trips through server/node.js.
const GEMINI = 'https://generativelanguage.googleapis.com/';
const realFetch = globalThis.fetch;
const apps = [];

async function start(env) {
  const app = createApp(env);
  apps.push(app);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${app.address().port}`;
}

function post(base, body, code = 'secret') {
  return realFetch(`${base}/api/recognize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-access-code': code },
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
  const get = await realFetch(`${base}/api/recognize`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await post(base, '{broken')).status, 400);
});
