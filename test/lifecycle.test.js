'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');
const push = require('../src/push');
const players = require('../src/game/players');
const pause = require('../src/game/pause');
const settings = require('../src/settings');
const commands = require('../src/game/commands');
const cfg = require('../src/config');

const tick = () => new Promise((r) => setImmediate(r));
const subscription = (name) => ({ endpoint: `https://push.example/${name}`, keys: { p256dh: 'p', auth: 'a' } });

test('push: subscribe, attack notification, preferences, activity, dead subscriptions', async () => {
  const s = await start();
  const calls = [];
  push.setTransport(async (sub, payload) => { calls.push({ sub, payload: JSON.parse(payload) }); });
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob');
    s.db.prepare('UPDATE user SET created_at = 0, last_seen = 0').run();
    assert.equal((await b.raw('/api/push/subscribe', { method: 'POST', json: { h: 'wrong', ...subscription('bob') } })).status, 403, 'needs the csrf token');
    assert.equal((await (await b.raw('/api/push/subscribe', { method: 'POST', json: { h: b.csrf, endpoint: 'http://insecure', keys: { p256dh: 'p', auth: 'a' } } })).json()).ok, false, 'https only');
    assert.equal((await (await b.raw('/api/push/subscribe', { method: 'POST', json: { h: b.csrf, ...subscription('bob') } })).json()).ok, true);
    assert.equal((await (await b.raw('/api/push/key')).json()).devices, 1);

    s.db.prepare("INSERT INTO village_unit VALUES (?, 'axe', 20)").run(a.vid);
    const attack = () => commands.send(s.db, { userId: 1, fromId: a.vid, toId: b.vid, units: { axe: 1 } });
    assert.ok(attack().ok);
    await tick();
    assert.equal(calls.length, 1, 'bob is pushed');
    assert.match(calls[0].payload.title, /Angriff/);
    assert.match(calls[0].payload.body, /alice/);

    // player who is looking at the game right now gets nothing
    s.db.prepare('UPDATE user SET last_seen = ? WHERE id = 2').run(Math.floor(Date.now() / 1000));
    attack(); await tick();
    assert.equal(calls.length, 1, 'active player is skipped');
    s.db.prepare('UPDATE user SET last_seen = 0 WHERE id = 2').run();

    // switched off in the notification settings
    s.db.prepare("UPDATE user SET notify = '{\"attack\":0}' WHERE id = 2").run();
    attack(); await tick();
    assert.equal(calls.length, 1, 'choice respected');
    s.db.prepare("UPDATE user SET notify = '{}' WHERE id = 2").run();

    // the test button ignores choices; a dead subscription is removed
    assert.equal((await (await b.raw('/api/push/test', { method: 'POST', json: { h: b.csrf } })).json()).sent, 1);
    push.setTransport(async () => { const e = new Error('gone'); e.statusCode = 410; throw e; });
    attack(); await tick(); await tick();
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM push_sub').get().n, 0, 'expired subscription dropped');
    // nothing is pushed while the world is paused
    push.setTransport(async (sub, payload) => { calls.push(JSON.parse(payload)); });
    await b.raw('/api/push/subscribe', { method: 'POST', json: { h: b.csrf, ...subscription('bob2') } });
    const before = calls.length;
    settings.set(s.db, 'paused', '1'); attack(); await tick();
    assert.equal(calls.length, before, 'paused world is silent');
  } finally { settings.set(s.db, 'paused', '0'); push.setTransport((sub, payload, o) => require('web-push').sendNotification(sub, payload, o)); s.close(); }
});

test('inactive players are removed, vacation protects the account, nothing dangles', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob'); const c = await s.client().register('carol');
    s.db.prepare('UPDATE user SET created_at = 0').run();
    s.db.prepare("INSERT INTO village_unit VALUES (?, 'axe', 20)").run(a.vid);
    assert.ok(commands.send(s.db, { userId: 1, fromId: a.vid, toId: b.vid, units: { axe: 5 } }).ok);
    const day = 86400; const nowS = Math.floor(Date.now() / 1000);
    s.db.prepare('UPDATE user SET last_seen = ? WHERE id IN (2, 3)').run(nowS - 10 * day);
    s.db.prepare('UPDATE user SET last_seen = ? WHERE id = 1').run(nowS - 10 * day);
    players.setVacation(s.db, 3, 7);
    assert.deepEqual(players.sweepInactive(s.db, 0), [], 'off when 0');
    assert.deepEqual(players.sweepInactive(s.db, 5), ['bob'], 'only bob: carol is on vacation, alice is an admin');
    const village = s.db.prepare('SELECT * FROM village WHERE id = ?').get(b.vid);
    assert.equal(village.user_id, null, 'village became barbarian');
    assert.equal(village.name, 'Barbarendorf');
    assert.equal(s.db.prepare("SELECT type FROM command").get().type, 'return', 'the attacker turns around');
    assert.equal(players.inactiveCandidates(s.db, 100).length, 0, 'carol is on vacation, alice is an admin');
    assert.equal(players.inactiveCandidates(s.db, 14).length, 0, 'vacation players are never candidates');
    assert.ok(s.db.prepare('SELECT COUNT(*) AS n FROM admin_log').get().n >= 1, 'logged');
    assert.equal((await c.screen('overview')).status, 200, 'carol unaffected');
  } finally { s.close(); }
});

test('paused world: players see the pause page, admins can look, resume shifts all timers', async () => {
  const s = await start();
  try {
    const admin = await s.client().register('alice'); const bob = await s.client().register('bob');
    s.db.prepare("INSERT INTO build_queue (village_id, building, level, start_at, finish_at) VALUES (?, 'wood', 2, 1000, 5000)").run(bob.vid);
    s.db.prepare("INSERT INTO command (type, from_village, to_village, units, depart_at, arrive_at) VALUES ('attack', ?, ?, '{}', 1000, 9000)").run(bob.vid, admin.vid);
    assert.equal((await admin.raw('/admin/world/pause', { method: 'POST', form: { h: admin.csrf } })).status, 302);
    assert.equal(pause.isPaused(), true);
    assert.equal((await bob.screen('overview')).status, 503, 'players are held back');
    assert.match(await (await bob.raw(`/game.php?village=${bob.vid}&screen=overview`)).text(), /pausiert/);
    assert.equal((await admin.screen('overview')).status, 503, 'the game is closed for admins too');
    assert.match(await (await admin.raw(`/game.php?village=${admin.vid}&screen=overview`)).text(), /Welt fortsetzen/, 'with a way back to the admin area');
    assert.match(await (await admin.raw('/admin/')).text(), /Die Welt ist pausiert/);
    // pretend the pause started 100 seconds ago
    settings.set(s.db, 'pausedAt', String(Date.now() / 1000 - 100));
    assert.equal((await admin.raw('/admin/world/resume', { method: 'POST', form: { h: admin.csrf } })).status, 302);
    assert.equal(pause.isPaused(), false);
    const q = s.db.prepare('SELECT * FROM build_queue').get();
    assert.ok(Math.abs(q.finish_at - 5100) < 2 && Math.abs(q.start_at - 1100) < 2, 'queue shifted');
    assert.ok(Math.abs(s.db.prepare('SELECT arrive_at FROM command').get().arrive_at - 9100) < 2, 'march shifted');
    assert.equal((await bob.screen('overview')).status, 200, 'playable again');
    assert.equal(pause.resume(s.db), false, 'resume without pause does nothing');
  } finally { settings.set(s.db, 'paused', '0'); s.close(); }
});

test('announcement banner, optional mail to everyone, vacation page', async () => {
  const s = await start();
  try {
    const admin = await s.client().register('alice'); const bob = await s.client().register('bob');
    await admin.raw('/admin/settings/announcement', { method: 'POST', form: { h: admin.csrf, text: 'Neustart um <22> Uhr', mail: '1' } });
    const page = (await bob.screen('overview')).html;
    assert.match(page, /Ankündigung:<\/b> Neustart um &lt;22&gt; Uhr/, 'banner, escaped');
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM message WHERE subject = 'Ankündigung'").get().n, 1, 'mailed to bob only');
    await admin.raw('/admin/settings/announcement', { method: 'POST', form: { h: admin.csrf, text: '' } });
    assert.doesNotMatch((await bob.screen('overview')).html, /Ankündigung:/, 'removed');
    assert.equal((await bob.screen('settings', { mode: 'vacation' })).status, 200);
    await bob.post('settings', { mode: 'vacation' }, { days: '99' });
    const until = s.db.prepare('SELECT vacation_until FROM user WHERE id = 2').get().vacation_until;
    assert.ok(until > Date.now() / 1000 + 13 * 86400 && until < Date.now() / 1000 + 15 * 86400, 'capped at 14 days');
    assert.match((await bob.screen('settings', { mode: 'notify' })).html, /push-box/, 'push switch on the notification page');
    assert.equal((await s.client().raw('/sw.js')).status, 200);
    assert.equal((await s.client().raw('/manifest.webmanifest')).status, 200);
  } finally { s.close(); cfg.ANNOUNCEMENT = ''; }
});
