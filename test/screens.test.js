'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');

// Assertions on whole pages: report only a short message, never the HTML.
const has = (html, re, msg) => assert.ok(re.test(html), `${msg}: expected ${re}`);
const hasNot = (html, re, msg) => assert.ok(!re.test(html), `${msg}: unexpected ${re}`);

test('every screen renders for a new player', async () => {
  const s = await start();
  try {
    const me = await s.client().register('alice');
    const screens = [
      ['overview'], ['main'], ['place'], ['place', { mode: 'units' }], ['report'], ['report', { mode: 'attack' }],
      ['ranking'], ['ranking', { mode: 'ally' }], ['ranking', { mode: 'con_player' }], ['ranking', { mode: 'kill_player' }],
      ['mail'], ['mail', { mode: 'new' }], ['mail', { mode: 'out' }], ['mail', { mode: 'address' }],
      ['ally'], ['settings'], ['settings', { mode: 'settings' }], ['settings', { mode: 'change_passwd' }], ['settings', { mode: 'delete' }],
      ['info_player'], ['notes'], ['help'], ['map'], ['wood'], ['storage'], ['hide'], ['farm'], ['barracks'], ['smith'],
    ];
    for (const [name, params] of screens) {
      const r = await me.screen(name, params);
      assert.equal(r.status, 200, `${name} ${JSON.stringify(params)}`);
      has(r.html, /<html/, name);
      if (name !== 'map') hasNot(r.html, /<%|undefined|\[object Object\]/, `${name} leaked template text`);
    }
  } finally { s.close(); }
});

test('settings: password change works, language switches the UI', async () => {
  const s = await start();
  try {
    const me = await s.client().register('alice');
    let r = await me.post('settings', { mode: 'change_passwd' }, { old_password: 'wrong1', new_password: 'newpass1', new_password2: 'newpass1' });
    assert.match(r.body, /falsch/);
    r = await me.post('settings', { mode: 'change_passwd' }, { old_password: 'secret1', new_password: 'newpass1', new_password2: 'newpass1' });
    assert.match(r.body, /geändert/);
    const login = await s.client().raw('/page/auth', { method: 'POST', form: { username: 'alice', password: 'newpass1' } });
    assert.ok((await login.json()).ok);
    r = await me.post('settings', { mode: 'settings' }, { lang: 'en' });
    assert.equal(r.status, 302);
    const page = await me.screen('overview');
    has(page.html, /Production|Overview/, 'english UI');
  } finally { s.close(); }
});

test('mail: send, receive, reply and delete', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob');
    let r = await a.post('mail', { mode: 'new', action: 'send' }, { to: 'bob', subject: 'Hallo', body: 'Wie gehts?' });
    assert.equal(r.status, 302);
    r = await a.post('mail', { mode: 'new', action: 'send' }, { to: 'nobody', subject: 'x', body: 'y' });
    assert.match(r.body, /nicht gefunden/);
    const inbox = await b.screen('mail');
    has(inbox.html, /Hallo/, 'inbox');
    const id = s.db.prepare('SELECT id FROM message').get().id;
    const view = await b.screen('mail', { view: id });
    has(view.html, /Wie gehts/, 'message view');
    assert.equal(s.db.prepare('SELECT is_read FROM message WHERE id=?').get(id).is_read, 1);
    await b.post('mail', { mode: 'in', action: 'delete' }, { ids: String(id) });
    assert.equal(s.db.prepare('SELECT deleted_in FROM message WHERE id=?').get(id).deleted_in, 1);
  } finally { s.close(); }
});

test('tribes: found, invite, join, forum post', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob');
    let r = await a.post('ally', { action: 'found' }, { name: 'Wolves', tag: 'WLF' });
    assert.equal(r.status, 302);
    r = await a.post('ally', { mode: 'invite', action: 'invite' }, { name: 'bob' });
    assert.match(r.body, /Einladung/);
    assert.match((await b.screen('ally')).html, /Wolves/);
    r = await b.post('ally', { action: 'accept' }, { ally: '1' });
    assert.equal(r.status, 302);
    r = await b.post('ally', { mode: 'forum', action: 'thread' }, { title: 'Plan', body: 'Wir greifen an' });
    assert.equal(r.status, 302);
    assert.match((await a.screen('ally', { mode: 'forum' })).html, /Plan/);
    assert.match((await a.screen('ally', { mode: 'members' })).html, /bob/);
    assert.match((await a.screen('info_ally', { id: 1 })).html, /Wolves/);
    assert.match((await a.screen('ranking', { mode: 'ally' })).html, /Wolves/);
  } finally { s.close(); }
});

test('forms reject requests without a valid token', async () => {
  const s = await start();
  try {
    const me = await s.client().register('alice');
    const q = new URLSearchParams({ village: me.vid, screen: 'settings', mode: 'profile' });
    const res = await me.raw(`/game.php?${q}`, { method: 'POST', form: { profile: 'hacked' } });
    assert.equal(res.status, 403);
    assert.equal(s.db.prepare('SELECT profile FROM user').get().profile, '');
  } finally { s.close(); }
});
