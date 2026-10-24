'use strict';
// Keep test backups out of the real data folder.
process.env.BACKUP_DIR = require('node:path').join(require('node:os').tmpdir(), `twlan-test-backups-${process.pid}`);
const { open } = require('../src/db');
const { createApp } = require('../src/app');

// Starts the app on a random port with an in-memory database and gives each "browser" its own cookie jar.
async function start(opts = {}) {
  const db = open(':memory:');
  const app = createApp(db, opts);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = '';
    const c = {
      vid: null, csrf: null,
      async raw(path, { method = 'GET', form, json, headers = {} } = {}) {
        const h = { cookie, ...headers };
        let body;
        if (form) { body = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
        if (json) { body = JSON.stringify(json); h['content-type'] = 'application/json'; }
        const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        return res;
      },
      async register(name, password = 'secret1') {
        const r = await c.raw('/page/register', { method: 'POST', form: { register_username: name, register_password: password } });
        const j = await r.json();
        if (!j.redirect) throw new Error(`register failed: ${JSON.stringify(j)}`);
        let play = await c.raw('/page/play');
        if (play.headers.get('location') === '/page/start') {
          const page = await (await c.raw('/page/start')).text();
          const h = /name="h" value="([a-f0-9]+)"/.exec(page)[1];
          await c.raw('/page/start', { method: 'POST', form: { h, direction: 'random' } });
          play = await c.raw('/page/play');
        }
        c.vid = Number(/village=(\d+)/.exec(play.headers.get('location'))[1]);
        await c.refresh();
        return c;
      },
      async refresh() {
        const html = await (await c.raw(`/game.php?village=${c.vid}&screen=overview`)).text();
        c.csrf = /csrf_token = "([a-f0-9]+)"/.exec(html)?.[1];
      },
      // GET a game screen and return { status, html }.
      async screen(screen, params = {}) {
        const q = new URLSearchParams({ village: c.vid, screen, ...params });
        const res = await c.raw(`/game.php?${q}`);
        return { status: res.status, location: res.headers.get('location'), html: res.status === 200 ? await res.text() : '' };
      },
      // POST a game form with the CSRF token filled in.
      async post(screen, params = {}, form = {}) {
        const q = new URLSearchParams({ village: c.vid, screen, ...params });
        const res = await c.raw(`/game.php?${q}`, { method: 'POST', form: { h: c.csrf, ...form } });
        return { status: res.status, location: res.headers.get('location'), body: await res.text() };
      },
      async ajax(screen, params = {}, form = {}) {
        const q = new URLSearchParams({ village: c.vid, screen, h: c.csrf, ...params });
        const res = await c.raw(`/game.php?${q}`, { method: 'POST', form, headers: { 'TribalWars-Ajax': '1' } });
        return res.json();
      },
    };
    return c;
  }

  return { db, base, client, close: () => server.close() };
}

module.exports = { start };
