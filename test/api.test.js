'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createApp } = require('../src/app');

async function start() {
  const app = createApp(open(':memory:'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (path, body) => {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, json: await res.json() };
  };
  return { call, close: () => server.close() };
}

test('register, create village, build, cancel', async () => {
  const { call, close } = await start();
  try {
    assert.equal((await call('/api/me')).status, 401);
    assert.ok((await call('/api/register', { username: 'mario', password: 'secret1' })).json.ok);
    assert.equal((await call('/api/register', { username: 'mario', password: 'secret1' })).json.error, 'Name already taken.');
    const created = (await call('/api/village/create', {})).json;
    assert.ok(created.ok);
    const state = (await call(`/api/village?village=${created.id}`)).json;
    assert.equal(state.levels.main, 5);
    const built = (await call('/api/village/build', { village: created.id, building: 'wood' })).json;
    assert.ok(built.ok, JSON.stringify(built));
    assert.equal(built.village.queue.length, 1);
    const cancelled = (await call('/api/village/cancel', { village: created.id, queue: built.village.queue[0].id })).json;
    assert.ok(cancelled.ok);
    assert.equal(cancelled.village.queue.length, 0);
  } finally { close(); }
});

test('login rejects wrong password and another user cannot see the village', async () => {
  const a = await start();
  try {
    await a.call('/api/register', { username: 'alice', password: 'secret1' });
    const { id } = (await a.call('/api/village/create', {})).json;
    await a.call('/api/logout', {});
    assert.ok((await a.call('/api/login', { username: 'alice', password: 'nope' })).json.error);
    await a.call('/api/register', { username: 'bob', password: 'secret1' });
    assert.equal((await a.call(`/api/village?village=${id}`)).status, 404);
  } finally { a.close(); }
});
