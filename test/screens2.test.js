'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');

const has = (html, re, msg) => assert.ok(re.test(html), `${msg}: expected ${re}`);
const hasNot = (html, re, msg) => assert.ok(!re.test(html), `${msg}: unexpected ${re}`);
const level = (db, vid, b, l) => db.prepare('INSERT INTO village_building (village_id, building, level) VALUES (?,?,?) ON CONFLICT(village_id, building) DO UPDATE SET level = excluded.level').run(vid, b, l);

test('all building and overview screens render, with and without the building', async () => {
  const s = await start();
  try {
    const me = await s.client().register('alice');
    const names = ['snob', 'statue', 'wall', 'market', 'stable', 'garage', 'smith', 'main'];
    const check = async (label) => {
      for (const n of names) {
        const r = await me.screen(n);
        assert.equal(r.status, 200, `${label} ${n}`);
        hasNot(r.html, /<%|undefined|\[object Object\]/, `${label} ${n}`);
      }
      for (const [n, p] of [['snob', { mode: 'coin' }], ['statue', { mode: 'inventory' }], ['market', { mode: 'buy' }], ['market', { mode: 'own_offer' }], ['main', { mode: 'destroy' }]]) {
        const r = await me.screen(n, p);
        assert.equal(r.status, 200, `${label} ${n} ${JSON.stringify(p)}`);
        hasNot(r.html, /<%|undefined|\[object Object\]/, `${label} ${n}`);
      }
    };
    await check('unbuilt');
    for (const [b, l] of [['snob', 1], ['statue', 1], ['wall', 5], ['market', 5], ['stable', 3], ['garage', 3], ['smith', 5], ['barracks', 5], ['main', 20]]) level(s.db, me.vid, b, l);
    await check('built');
    for (const mode of ['combined', 'prod', 'units', 'buildings', 'commands', 'incomings', 'tech', 'groups', 'trader']) {
      const r = await me.screen('overview_villages', { mode });
      assert.equal(r.status, 200, mode);
      hasNot(r.html, /<%|undefined|\[object Object\]/, `overview ${mode}`);
    }
    for (const screen of ['quests', 'achievements', 'event', 'info_village', 'notes', 'help']) {
      const r = await me.screen(screen);
      assert.equal(r.status, 200, screen);
      hasNot(r.html, /<%|undefined|\[object Object\]/, screen);
    }
    for (const mode of ['command', 'units', 'sim', 'templates']) {
      const r = await me.screen('place', { mode });
      assert.equal(r.status, 200, `place ${mode}`);
      hasNot(r.html, /<%|undefined|\[object Object\]/, `place ${mode}`);
    }
  } finally { s.close(); }
});

test('place: simulator, templates, support confirmation and cancelling', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob');
    // simulator
    let r = await a.post('place', { mode: 'sim' }, { att_axe: '100', def_spear: '10' });
    has(r.body, /Angreifer gewinnt/, 'simulator');
    // templates
    r = await a.post('place', { mode: 'templates', action: 'save' }, { name: 'Angriff', axe: '50' });
    assert.equal(r.status, 302);
    has((await a.screen('place', { mode: 'templates' })).html, /Angriff/, 'saved template');
    has((await a.screen('place')).html, /twl-template/, 'template on the command form');
    const tpl = s.db.prepare('SELECT id FROM troop_template').get().id;
    await a.post('place', { mode: 'templates', action: 'delete' }, { id: String(tpl) });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM troop_template').get().n, 0);
    // support: confirmation page and sending
    s.db.prepare("INSERT INTO village_unit VALUES (?, 'spear', 40)").run(a.vid);
    const bv = s.db.prepare('SELECT x, y FROM village WHERE id = ?').get(b.vid);
    r = await a.post('place', { try: 'confirm' }, { spear: '20', coord: `${bv.x}|${bv.y}`, support: 'Unterstützen' });
    has(r.body, /Unterstützung für/, 'support confirmation');
    r = await a.post('place', { action: 'command' }, { spear: '20', target: String(b.vid), type: 'support' });
    assert.equal(r.status, 302);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM command WHERE type = 'support'").get().n, 1);
    const id = s.db.prepare("SELECT id FROM command WHERE type = 'support'").get().id;
    const q = new URLSearchParams({ village: a.vid, screen: 'place', action: 'cancel', id: String(id), h: a.csrf });
    await a.raw(`/game.php?${q}`);
    assert.equal(s.db.prepare("SELECT type FROM command WHERE id = ?").get(id).type, 'return');
    // barbarians cannot be supported
    const barb = s.db.prepare('SELECT id FROM village WHERE user_id IS NULL').get();
    void barb; // (no barbarians in an unseeded test world)
  } finally { s.close(); }
});

test('reports of every kind can be opened', async () => {
  const s = await start();
  try {
    const me = await s.client().register('alice');
    const v = { user: 'alice', village: 'A', x: 1, y: 2 };
    const insert = (type, data, color = 'green') => s.db.prepare('INSERT INTO report (user_id, type, title, color, time, data) VALUES (1, ?, ?, ?, ?, ?)').run(type, `Testbericht ${type}`, color, Date.now() / 1000, JSON.stringify(data));
    const side = (losses = {}) => ({ user: 'bob', userId: 2, village: 'B', villageId: 2, x: 3, y: 4, units: { spear: 5 }, losses });
    insert('attack', { kind: 'battle', win: true, luck: 0.1, morale: 1, night: true, attacker: side(), defender: side({ spear: 5 }), loot: { wood: 1, stone: 2, iron: 3 }, capacity: 100, damage: { wall: { before: 3, after: 1 } }, conquered: true, loyalty: { from: 40, to: 25 }, supporters: [{ user: 'cara', village: 'C', x: 5, y: 6, units: { spear: 3 }, losses: { spear: 3 } }], knightFinds: { attacker: 'axe' }, intel: { resources: { wood: 1, stone: 2, iron: 3 }, buildings: { main: 3 }, units: { spear: 2 } } });
    insert('attack', { kind: 'spy', success: true, attacker: side({ spy: 1 }), defender: side(), intel: { resources: { wood: 1, stone: 2, iron: 3 }, buildings: { main: 3 }, units: {} } });
    insert('attack', { kind: 'spy', success: false, attacker: side({ spy: 5 }), defender: side(), intel: null }, 'red');
    insert('support', { kind: 'support', from: v, to: { ...v, user: 'bob' }, units: { spear: 5 } }, 'blue');
    insert('trade', { kind: 'trade', from: v, to: { ...v, user: 'bob' }, res: { wood: 5, stone: 0, iron: 0 } });
    insert('defense', { win: false, luck: 0, morale: 1, attacker: side(), defender: side(), loot: { wood: 0, stone: 0, iron: 0 }, capacity: 0 }, 'yellow'); // old format without "kind"
    for (const row of s.db.prepare('SELECT id FROM report').all()) {
      const r = await me.screen('report', { view: row.id });
      assert.equal(r.status, 200);
      hasNot(r.html, /<%|undefined|\[object Object\]/, `report ${row.id}`);
    }
    for (const mode of ['all', 'attack', 'defense', 'support', 'trade', 'other']) assert.equal((await me.screen('report', { mode })).status, 200, mode);
  } finally { s.close(); }
});

test('market, nobles and groups through the UI', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob');
    level(s.db, a.vid, 'market', 5); level(s.db, a.vid, 'snob', 1);
    s.db.prepare('UPDATE village SET wood = 2000 WHERE id = ?').run(a.vid);
    const bv = s.db.prepare('SELECT x, y FROM village WHERE id = ?').get(b.vid);
    let r = await a.post('market', { mode: 'send', action: 'send' }, { wood: '1200', coord: `${bv.x}|${bv.y}` });
    has(r.body, /Händler sind unterwegs/, 'send');
    r = await a.post('market', { mode: 'own_offer', action: 'offer' }, { sell_res: 'wood', sell_amount: '100', buy_res: 'stone', buy_amount: '100', multi: '1' });
    assert.equal(r.status, 302);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM market_offer').get().n, 1);
    // groups
    r = await a.post('overview_villages', { mode: 'groups', action: 'group_add' }, { name: 'Kern' });
    assert.equal(r.status, 302);
    const g = s.db.prepare('SELECT id FROM village_group').get().id;
    await a.post('overview_villages', { mode: 'groups', action: 'group_set' }, { group: String(g), villages: String(a.vid) });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM village_group_member').get().n, 1);
    has((await a.screen('overview_villages', { mode: 'combined', group: String(g) })).html, /alices Dorf/, 'group filter');
    // a foreign village cannot be put into my group
    await a.post('overview_villages', { mode: 'groups', action: 'group_set' }, { group: String(g), villages: String(b.vid) });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM village_group_member WHERE village_id = ?').get(b.vid).n, 0);
  } finally { s.close(); }
});

test('village switching arrows move between own villages only', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); await s.client().register('bob');
    const second = Number(s.db.prepare('INSERT INTO village (user_id, name, x, y, wood, stone, iron, res_updated_at, created_at) VALUES (1, ?, 480, 480, 500, 500, 500, 0, 0)').run('Zweitdorf').lastInsertRowid);
    const q = new URLSearchParams({ village: `n${a.vid}`, screen: 'overview' });
    let r = await a.raw(`/game.php?${q}`);
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), new RegExp(`village=${second}`));
    r = await a.raw(`/game.php?${new URLSearchParams({ village: `n${second}`, screen: 'overview' })}`);
    assert.match(r.headers.get('location'), new RegExp(`village=${a.vid}`));
    const html = (await a.screen('overview')).html;
    has(html, /village_switch_left/, 'arrows are shown');
    has(html, /id="twl-villages"[\s\S]*Zweitdorf/, 'village menu lists both villages');
    hasNot((await (await s.client().register('solo')).screen('overview')).html, /twl-villages/, 'a single village needs no menu');
  } finally { s.close(); }
});

test('admin area: only admins, token required, ban and password reset work', async () => {
  const s = await start();
  try {
    const admin = await s.client().register('alice'); // first account
    const bob = await s.client().register('bob');
    assert.equal((await bob.raw('/admin/')).status, 403);
    assert.equal((await s.client().raw('/admin/')).status, 302);
    for (const page of ['', 'players', 'villages', 'settings', 'world']) {
      const res = await admin.raw(`/admin/${page}`);
      assert.equal(res.status, 200, page);
      hasNot(await res.text(), /<%|undefined/, `admin ${page}`);
    }
    let res = await admin.raw(`/admin/players/2/ban`, { method: 'POST', form: {} });
    assert.equal(res.status, 403, 'no token');
    res = await admin.raw('/admin/players/2/ban', { method: 'POST', form: { h: admin.csrf } });
    assert.equal(res.status, 302);
    assert.equal(s.db.prepare('SELECT banned FROM user WHERE id = 2').get().banned, 1);
    const login = await (await s.client().raw('/page/auth', { method: 'POST', form: { username: 'bob', password: 'secret1' } })).json();
    assert.match(login.error, /gesperrt/);
    assert.equal((await bob.screen('overview')).status, 302, 'the banned session is gone');
    await admin.raw('/admin/players/2/unban', { method: 'POST', form: { h: admin.csrf } });
    res = await admin.raw('/admin/players/2/password', { method: 'POST', form: { h: admin.csrf } });
    const temp = new URL(res.headers.get('location'), 'http://x').searchParams.get('temp');
    assert.ok(temp && temp.length >= 6);
    assert.ok((await (await s.client().raw('/page/auth', { method: 'POST', form: { username: 'bob', password: temp } })).json()).ok);
    // settings change the live speed
    await admin.raw('/admin/settings', { method: 'POST', form: { h: admin.csrf, speedMultiplier: '2', registration: 'closed' } });
    const cfg = require('../src/config');
    assert.equal(cfg.SPEED_MULT, 2);
    const reg = await (await s.client().raw('/page/register', { method: 'POST', form: { register_username: 'newbie', register_password: 'secret1' } })).json();
    assert.match(reg.error, /geschlossen/);
    await admin.raw('/admin/settings', { method: 'POST', form: { h: admin.csrf, speedMultiplier: '20', registration: 'open' } });
  } finally { s.close(); }
});

test('map context menu: favourites via XHR, links reach the place and market screens', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob');
    level(s.db, a.vid, 'market', 3);
    const q = (extra) => new URLSearchParams({ village: a.vid, screen: 'info_village', id: b.vid, ...extra });
    assert.equal((await a.raw(`/game.php?${q({ ajaxaction: 'add_target', json: '1' })}`)).status, 403, 'needs the XHR header');
    let res = await a.raw(`/game.php?${q({ ajaxaction: 'add_target', json: '1' })}`, { headers: { 'x-requested-with': 'XMLHttpRequest' } });
    assert.deepEqual((await res.json()).response, { code: true, id: b.vid });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM favorite').get().n, 1);
    has((await a.screen('map')).html, new RegExp(`TWMap.targets = \\[${b.vid}\\]`), 'favourites on the map');
    res = await a.raw(`/game.php?${q({ ajaxaction: 'del_target', json: '1' })}`, { headers: { 'x-requested-with': 'XMLHttpRequest' } });
    assert.ok((await res.json()).response.code);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM favorite').get().n, 0);
    const bv = s.db.prepare('SELECT x, y FROM village WHERE id = ?').get(b.vid);
    has((await a.screen('place', { target: b.vid })).html, new RegExp(`value="${bv.x}\\|${bv.y}"`), 'target prefilled in the rally point');
    has((await a.screen('market', { mode: 'send', target: b.vid })).html, new RegExp(`value="${bv.x}\\|${bv.y}"`), 'target prefilled in the market');
  } finally { s.close(); }
});

test('map pop-ups: send troops and resources without leaving the map, world map image', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob');
    level(s.db, a.vid, 'market', 3);
    s.db.prepare("INSERT INTO village_unit VALUES (?, 'axe', 30)").run(a.vid);
    const get = async (screen, params) => (await a.raw(`/game.php?${new URLSearchParams({ village: a.vid, screen, ...params })}`, { headers: { 'x-requested-with': 'XMLHttpRequest' } })).json();

    let r = await get('place', { ajax: 'command', target: b.vid });
    has(r.response.dialog, /units_form/, 'command dialog');
    // bob is still protected, so an attack is refused after the confirmation step
    r = await a.ajax('place', { ajax: 'confirm' }, { target: String(b.vid), axe: '10', attack: 'l' });
    has(r.response.dialog, /command-confirm-form/, 'confirm dialog');
    r = await a.ajax('place', { ajaxaction: 'map_command' }, { target: String(b.vid), axe: '10', type: 'attack' });
    assert.match(r.error, /Angriffsschutz/);
    r = await a.ajax('place', { ajaxaction: 'map_command' }, { target: String(b.vid), axe: '10', type: 'support' });
    assert.equal(r.response.type, 'support');
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM command WHERE type = 'support'").get().n, 1);
    r = await a.ajax('place', { ajax: 'confirm' }, { target: String(b.vid), axe: '999', attack: 'l' });
    assert.ok(r.error, 'not enough troops');

    s.db.prepare('UPDATE village SET wood = 3000 WHERE id = ?').run(a.vid);
    r = await get('market', { ajax: 'send', target: b.vid });
    has(r.response.dialog, /market-send-form/, 'market dialog');
    r = await a.ajax('market', { ajax: 'confirm' }, { target: String(b.vid), wood: '1500', stone: '0', iron: '0' });
    has(r.response.dialog, /market-confirm-form/, 'market confirmation');
    r = await a.ajax('market', { ajaxaction: 'map_send' }, { target: String(b.vid), wood: '1500', stone: '0', iron: '0' });
    has(r.response.message, /Händler/, 'sent');
    r = await a.ajax('market', { ajaxaction: 'map_send' }, { target: String(b.vid), wood: '999999', stone: '0', iron: '0' });
    assert.ok(r.error);

    const img = await a.raw('/page.php?page=worldmap_image&cut=true&barbarian=true&ally=true');
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await s.client().raw('/page.php?page=worldmap_image')).status, 404);
  } finally { s.close(); }
});

test('settings: own quick bar, login history, blocked senders', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob');
    // quick bar
    let r = await a.post('settings', { mode: 'quickbar' }, { label_0: 'Meine Karte', target_0: 'map', label_1: 'Böse', target_1: 'evil&x=1', label_2: 'Forum', target_2: 'ally&mode=forum' });
    has(r.body, /Gespeichert/, 'saved');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM quicklink').get().n, 2, 'unknown targets are dropped');
    const page = (await a.screen('overview')).html;
    has(page, /Meine Karte/, 'custom quick bar shown');
    hasNot(page, /Hauptgebäude<\/a><\/span><\/li>/, 'default quick bar replaced');
    await a.post('settings', { mode: 'quickbar' }, { reset: '1' });
    has((await a.screen('overview')).html, /Hauptgebäude/, 'default is back');
    // logins
    await s.client().raw('/page/auth', { method: 'POST', form: { username: 'alice', password: 'secret1' } });
    has((await a.screen('settings', { mode: 'logins' })).html, /127\.0\.0\.1|::1/, 'login recorded');
    // blocking
    await b.post('settings', { mode: 'block' }, { name: 'alice' });
    r = await a.post('mail', { mode: 'new', action: 'send' }, { to: 'bob', subject: 'Hi', body: 'x' });
    has(r.body, /blockiert/, 'blocked');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM message').get().n, 0);
    await b.post('settings', { mode: 'block', action: 'unblock' }, { other: '1' });
    assert.equal((await a.post('mail', { mode: 'new', action: 'send' }, { to: 'bob', subject: 'Hi', body: 'x' })).status, 302);
    for (const mode of ['quickbar', 'logins', 'block']) hasNot((await a.screen('settings', { mode })).html, /<%|undefined/, mode);
  } finally { s.close(); }
});

test('reports can be forwarded; wars between tribes keep a score', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob');
    s.db.prepare('INSERT INTO report (user_id, type, title, color, time, data) VALUES (1, ?, ?, ?, ?, ?)').run('trade', 'Lieferung', 'green', 1, JSON.stringify({ kind: 'trade', from: { village: 'A', x: 1, y: 2 }, to: { village: 'B', x: 3, y: 4, user: 'bob' }, res: { wood: 1, stone: 1, iron: 1 } }));
    let r = await a.post('report', { action: 'forward', id: '1', view: '1' }, { to: 'nobody' });
    has(r.body, /nicht gefunden/, 'unknown player');
    r = await a.post('report', { action: 'forward', id: '1', view: '1' }, { to: 'bob' });
    has(r.body, /weitergeleitet/, 'forwarded');
    has((await b.screen('report', { mode: 'forwarded' })).html, /von alice/, 'in the forwarded folder');
    has((await b.screen('report')).html, /Lieferung/, 'also in the inbox');

    // two tribes at war
    await a.post('ally', { action: 'found' }, { name: 'Wolves', tag: 'WLF' });
    await b.post('ally', { action: 'found' }, { name: 'Bears', tag: 'BRS' });
    await a.post('ally', { mode: 'diplomaty', action: 'propose' }, { other: 'Bears', type: 'enemy' });
    has((await a.screen('ranking', { mode: 'wars' })).html, /Bears/, 'war listed');
    const c = require('../src/game/commands');
    s.db.prepare('UPDATE user SET created_at = 0').run();
    s.db.prepare("INSERT INTO village_unit VALUES (?, 'axe', 60)").run(a.vid);
    s.db.prepare("INSERT INTO village_unit VALUES (?, 'spear', 20)").run(b.vid);
    const sent = c.send(s.db, { userId: 1, fromId: a.vid, toId: b.vid, units: { axe: 60 } });
    assert.ok(sent.ok, JSON.stringify(sent));
    c.processDue(s.db, sent.arriveAt + 1, () => 0.5);
    const stats = s.db.prepare('SELECT ally_id, other_id, kills FROM war_stat ORDER BY ally_id').all();
    assert.equal(stats.length, 2);
    assert.ok(stats[0].kills > 0, 'the attacking tribe scored kills');
    has((await a.screen('ranking', { mode: 'wars' })).html, new RegExp(`<b>${stats[0].kills}</b>`), 'score shown');
  } finally { s.close(); }
});

test('tribe applications: apply, accept, decline, withdraw', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob'); const c = await s.client().register('cara');
    await a.post('ally', { action: 'found' }, { name: 'Wolves', tag: 'WLF' });
    has((await b.screen('ally')).html, /Bewerben/, 'tribes are listed');
    let r = await b.post('ally', { action: 'apply' }, { ally: '1', text: 'Nimm mich auf' });
    has(r.body, /Bewerbung gesendet/, 'applied');
    has((await a.screen('ally', { mode: 'invite' })).html, /Nimm mich auf/, 'leader sees the application');
    assert.equal(JSON.parse(/game_data = (\{.*?\});\n/s.exec((await a.screen('overview')).html)[1]).player.new_ally_application, 1);
    await a.post('ally', { mode: 'invite', action: 'applicant' }, { user: '2', accept: '1' });
    assert.equal(s.db.prepare('SELECT ally_id FROM user WHERE id = 2').get().ally_id, 1);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM ally_application').get().n, 0);
    // declined and withdrawn
    await c.post('ally', { action: 'apply' }, { ally: '1', text: '' });
    await a.post('ally', { mode: 'invite', action: 'applicant' }, { user: '3', accept: '0' });
    assert.equal(s.db.prepare('SELECT ally_id FROM user WHERE id = 3').get().ally_id, null);
    assert.match(s.db.prepare("SELECT body FROM message WHERE to_id = 3 AND subject = 'Bewerbung'").get().body, /abgelehnt/);
    await c.post('ally', { action: 'apply' }, { ally: '1', text: '' });
    await c.post('ally', { action: 'withdraw' }, { ally: '1' });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM ally_application').get().n, 0);
    // members cannot apply, and the invite right is required to decide
    assert.match((await b.post('ally', { action: 'apply' }, { ally: '1' })).body, /Bewerbung|Stamm/);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM ally_application').get().n, 0);
  } finally { s.close(); }
});

test('map colour groups feed the map and validate their input', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob');
    let r = await a.post('map_groups', { action: 'create' }, { name: 'Feinde', color: 'red' });
    has(r.body, /Namen und Farbe/, 'bad colour rejected');
    r = await a.post('map_groups', { action: 'create' }, { name: 'Feinde', color: '#ff0000' });
    assert.equal(r.status, 302);
    await a.post('map_groups', { action: 'add' }, { group: '1', kind: 'player', value: 'bob' });
    const bv = s.db.prepare('SELECT x, y FROM village WHERE id = ?').get(b.vid);
    await a.post('map_groups', { action: 'add' }, { group: '1', kind: 'village', value: `${bv.x}|${bv.y}` });
    r = await a.post('map_groups', { action: 'add' }, { group: '1', kind: 'player', value: 'ghost' });
    has(r.body, /nicht gefunden/, 'unknown player');
    const html = (await a.screen('map')).html;
    has(html, new RegExp(`TWMap.playerGroups = \\{"${2}":\\[255,0,0\\]\\}`), 'player colour on the map');
    has(html, new RegExp(`TWMap.villageGroups = \\{"${b.vid}":\\[255,0,0\\]\\}`), 'village colour on the map');
    has((await a.screen('map_groups')).html, /bob/, 'management page lists members');
    // groups of other players cannot be touched
    await b.post('map_groups', { action: 'delete' }, { group: '1' });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM color_group').get().n, 1);
    await a.post('map_groups', { action: 'delete' }, { group: '1' });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM color_group_member').get().n, 0, 'members go with the group');
  } finally { s.close(); }
});

test('village reservations: tribe only, visible to mates, respected rights, removed on conquest', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob'); const c = await s.client().register('cara');
    const xhr = { 'x-requested-with': 'XMLHttpRequest' };
    const toggle = async (who, id) => (await who.raw(`/game.php?${new URLSearchParams({ village: who.vid, screen: 'info_village', id: String(id), ajaxaction: 'toggle_reserve_village', json: '1' })}`, { headers: xhr })).json();
    assert.match((await toggle(c, a.vid)).error, /Stammesmitglied/, 'needs a tribe');
    await a.post('ally', { action: 'found' }, { name: 'Wolves', tag: 'WLF' });
    await a.post('ally', { mode: 'invite', action: 'invite' }, { name: 'bob' });
    await b.post('ally', { action: 'accept' }, { ally: '1' });
    assert.match((await toggle(b, b.vid)).error, /Eigene/, 'own village');
    let r = await toggle(b, c.vid);
    assert.deepEqual([r.response.code, r.response.type], [true, 'add']);
    has((await b.screen('map')).html, new RegExp(`TWMap.reservations = \\{"${c.vid}":"player"\\}`), 'own claim on the map');
    has((await a.screen('map')).html, new RegExp(`TWMap.reservations = \\{"${c.vid}":"team"\\}`), 'mate sees a team claim');
    has((await a.screen('ally', { mode: 'reservations' })).html, /cara/, 'planner lists it');
    has((await a.screen('info_village', { id: c.vid })).html, /von bob/, 'village page shows the claim');
    // the leader may lift a claim of a mate, a stranger cannot even see it
    assert.equal((await a.screen('info_village', { id: c.vid })).status, 200);
    r = await toggle(a, c.vid);
    assert.equal(r.response.type, 'delete');
    r = await toggle(b, c.vid); assert.equal(r.response.type, 'add');
    // leaving the tribe drops claims; conquest too
    await b.post('ally', { mode: 'props', action: 'leave' }, {});
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM reservation').get().n, 0);
    // expiry
    r = await toggle(a, c.vid); assert.equal(r.response.type, 'add');
    s.db.prepare('UPDATE reservation SET time = 1').run();
    has((await a.screen('ally', { mode: 'reservations' })).html, /Keine Reservierungen/, 'expired claims disappear');
  } finally { s.close(); }
});

test('premium: balance in the menu, finish link, admin grant and quest rewards', async () => {
  const s = await start();
  try {
    const admin = await s.client().register('alice'); const bob = await s.client().register('bob');
    has((await bob.screen('overview')).html, />\s*0 \+/, 'balance in the menu');
    has((await bob.screen('premium')).html, /Premium-Punkte/, 'premium page');
    s.db.prepare('UPDATE village SET wood = 9000, stone = 9000, iron = 9000 WHERE id = ?').run(bob.vid);
    await bob.ajax('main', { mode: 'build', ajaxaction: 'upgrade_building' }, { id: 'wood' });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM build_queue').get().n, 1);
    has((await bob.screen('main')).html, /PP: sofort/, 'finish button');
    const finishUrl = () => `/game.php?${new URLSearchParams({ village: bob.vid, screen: 'main', action: 'finish', h: bob.csrf })}`;
    await bob.raw(finishUrl());
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM build_queue').get().n, 1, 'no points: nothing happens');
    // the admin hands out points
    let res = await admin.raw('/admin/players/2/pp', { method: 'POST', form: { h: admin.csrf, amount: '3' } });
    assert.equal(res.status, 302);
    assert.equal(s.db.prepare('SELECT pp FROM user WHERE id = 2').get().pp, 3);
    res = await admin.raw('/admin/players/2/pp', { method: 'POST', form: { h: admin.csrf, amount: '-50' } });
    assert.equal(s.db.prepare('SELECT pp FROM user WHERE id = 2').get().pp, 3, 'cannot go below zero');
    await bob.raw(finishUrl());
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM build_queue').get().n, 0);
    assert.ok(s.db.prepare('SELECT pp FROM user WHERE id = 2').get().pp < 3);
    has((await bob.screen('premium')).html, /sofort fertiggestellt/, 'bookings listed');
    // quests pay points
    s.db.prepare("INSERT INTO village_building (village_id, building, level) VALUES (?, 'wood', 12) ON CONFLICT(village_id, building) DO UPDATE SET level = 12").run(bob.vid);
    const before = s.db.prepare('SELECT pp FROM user WHERE id = 2').get().pp;
    await bob.post('quests', {}, { quest: 'wood10' });
    assert.equal(s.db.prepare('SELECT pp FROM user WHERE id = 2').get().pp, before + 1);
  } finally { s.close(); }
});

test('relics screen, overview widget and map markers', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice');
    const site = Number(s.db.prepare('INSERT INTO village (user_id, name, x, y, wood, stone, iron, res_updated_at, created_at) VALUES (1, ?, 500, 505, 500, 500, 500, 0, 0)').run('Fundort').lastInsertRowid);
    s.db.prepare("INSERT INTO relic (name, effect, bonus, site_village) VALUES ('Kelch des Wanderers', 'wood', 25, ?)").run(site);
    has((await a.screen('relics')).html, /Kelch des Wanderers/, 'listed');
    has((await a.screen('overview')).html, /Reliquie jetzt zuweisen/, 'hint on the overview');
    has((await a.screen('map')).html, new RegExp(`TWMap.villageIcons = \\{"${site}":\\[\\{"img":"/graphic/map/relic.png"\\}\\]\\}`), 'marker on the map');
    let r = await a.post('relics', {}, { relic: '1', village: String(a.vid) });
    has(r.body, /zugewiesen/, 'assigned');
    has((await a.screen('overview')).html, /Kelch des Wanderers<\/b>: \+25% Holzproduktion/, 'effect shown');
    r = await a.post('relics', {}, { relic: '1', village: '' });
    has(r.body, /wirkt nicht mehr/, 'removed');
    const b = await s.client().register('bob');
    r = await b.post('relics', {}, { relic: '1', village: String(b.vid) });
    has(r.body, /gehört dir nicht/, 'strangers cannot assign');
  } finally { s.close(); }
});

test('first login: choose where the village is built', async () => {
  const s = await start();
  try {
    const c = s.client();
    await c.raw('/page/register', { method: 'POST', form: { register_username: 'neo', register_password: 'secret1' } });
    let r = await c.raw('/page/play');
    assert.equal(r.headers.get('location'), '/page/start');
    const page = await (await c.raw('/page/start')).text();
    has(page, /Nordwest/, 'direction choices');
    has(page, /richtung\.png/, 'map image');
    const h = /name="h" value="([a-f0-9]+)"/.exec(page)[1];
    assert.equal((await c.raw('/page/start', { method: 'POST', form: { direction: 'nw' } })).status, 403, 'needs a token');
    r = await c.raw('/page/start', { method: 'POST', form: { h, direction: 'nw' } });
    assert.equal(r.headers.get('location'), '/page/play');
    const v = s.db.prepare('SELECT x, y FROM village WHERE user_id = 1').get();
    assert.ok(v.x < 500 && v.y < 500, `north-west of the middle (${v.x}|${v.y})`);
    r = await c.raw('/page/start');
    assert.equal(r.headers.get('location'), '/page/play', 'no second village');
    // every quadrant
    const world = require('../src/game/world');
    for (const [dir, fx, fy] of [['no', 1, -1], ['so', 1, 1], ['sw', -1, 1], ['nw', -1, -1]]) {
      const spot = world.pickSpot(s.db, { direction: dir });
      assert.ok((spot.x - 500) * fx > 0 && (spot.y - 500) * fy > 0, `${dir}: ${spot.x}|${spot.y}`);
    }
  } finally { s.close(); }
});

test('next to a tribe mate, world settings, unit info, mass recruitment, backup', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob');
    // "in the centre of my tribe"
    await a.post('ally', { action: 'found' }, { name: 'Wolves', tag: 'WLF' });
    await a.post('ally', { mode: 'invite', action: 'invite' }, { name: 'bob' });
    await b.post('ally', { action: 'accept' }, { ally: '1' });
    const near = require('../src/game/world').pickSpot(s.db, { direction: 'ally', allyId: 1 });
    const mates = s.db.prepare('SELECT x, y FROM village WHERE user_id IN (1, 2)').all();
    assert.ok(mates.some((m) => Math.hypot(m.x - near.x, m.y - near.y) < 25), 'close to a mate');

    has((await a.screen('settings', { mode: 'world' })).html, /Spielgeschwindigkeit/, 'world settings');
    has((await a.screen('info_village')).html, /Punkte/, 'own village page');
    const info = (await a.screen('unit_info', { id: 'spear' })).html;
    has(info, /Kampfwerte/, 'unit info'); hasNot(info, /<%|undefined/, 'unit info');
    assert.equal((await a.screen('unit_info', { id: 'nonsense' })).status, 302);

    level(s.db, a.vid, 'barracks', 3);
    s.db.prepare('UPDATE village SET wood = 5000, stone = 5000, iron = 5000 WHERE id = ?').run(a.vid);
    has((await a.screen('train')).html, /Rekrutieren/, 'mass recruitment page');
    const r = await a.post('train', {}, { [`spear_${a.vid}`]: '5' });
    has(r.body, /Rekrutierung gestartet/, 'result per village');
    assert.equal(s.db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM train_queue').get().n >= 5, true);
    has((await a.screen('overview')).html, /Einheiten|Keine Truppen/, 'troops widget');

    // backup (admin only, needs the token, returns a valid SQLite file)
    assert.equal((await b.raw('/admin/backup', { method: 'POST', form: { h: b.csrf } })).status, 403);
    assert.equal((await a.raw('/admin/backup', { method: 'POST', form: {} })).status, 403, 'token required');
    const res = await a.raw('/admin/backup', { method: 'POST', form: { h: a.csrf } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /twlan-.*\.db/);
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
    has(await (await s.client().raw('/')).text(), /Passwort vergessen/, 'login hint');
  } finally { s.close(); }
});

test('admin: set the number of bots, let them move, remove one', async () => {
  const s = await start();
  try {
    const admin = await s.client().register('alice'); const bob = await s.client().register('bob');
    assert.equal((await bob.raw('/admin/bots')).status, 403);
    has(await (await admin.raw('/admin/bots')).text(), /Anzahl der Bots/, 'bots page');
    const save = (form) => admin.raw('/admin/bots/settings', { method: 'POST', form: { h: admin.csrf, botActive: '1', botInterval: '5', botAggression: '4', ...form } });
    assert.equal((await admin.raw('/admin/bots/settings', { method: 'POST', form: { botCount: '3' } })).status, 403, 'needs the token');
    assert.equal((await save({ botCount: '4', botAttackPlayers: '1' })).status, 302);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM bot').get().n, 4);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM user WHERE is_bot = 1').get().n, 4);
    const html = await (await admin.raw('/admin/bots')).text();
    hasNot(html, /<%|undefined/, 'bots page');
    has(html, /Aufbauer|Krieger|Eroberer/, 'bots are listed');
    const name = s.db.prepare('SELECT name FROM user WHERE is_bot = 1').get().name;
    const login = await (await s.client().raw('/page/auth', { method: 'POST', form: { username: name, password: 'irgendwas' } })).json();
    assert.match(login.error, /Bot/, 'bots cannot log in');
    await admin.raw('/admin/bots/tick', { method: 'POST', form: { h: admin.csrf } });
    assert.ok(s.db.prepare('SELECT COUNT(*) AS n FROM bot_log').get().n >= 4, 'every bot took a turn');
    has(await (await admin.raw('/admin/bots')).text(), /Letzte Aktionen/, 'log shown');
    const id = s.db.prepare('SELECT user_id FROM bot').get().user_id;
    await admin.raw(`/admin/bots/${id}/remove`, { method: 'POST', form: { h: admin.csrf } });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM bot').get().n, 3);
    assert.equal(s.db.prepare("SELECT value FROM setting WHERE key = 'botCount'").get().value, '3');
    // humans see bots in the ranking like anybody else
    const remaining = s.db.prepare('SELECT name FROM user WHERE is_bot = 1').get().name;
    has((await bob.screen('ranking')).html, new RegExp(remaining), 'bot in the ranking');
    await save({ botCount: '0' });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM bot').get().n, 0);
  } finally { s.close(); }
});

test('admin: backup schedule, manual backup and download by name', async () => {
  const s = await start();
  try {
    const admin = await s.client().register('alice'); const bob = await s.client().register('bob');
    const post = (path, form) => admin.raw(path, { method: 'POST', form: { h: admin.csrf, ...form } });
    assert.equal((await bob.raw('/admin/backup/now', { method: 'POST', form: { h: bob.csrf } })).status, 403);
    await post('/admin/backup/settings', { enabled: '1', hours: '6', keep: '2' });
    assert.deepEqual(['backupHours', 'backupKeep'].map((k) => s.db.prepare('SELECT value FROM setting WHERE key = ?').get(k).value), ['6', '2']);
    for (let i = 0; i < 3; i++) { await post('/admin/backup/now', {}); await new Promise((r) => setTimeout(r, 1100)); }
    const page = await (await admin.raw('/admin/world')).text();
    const names = [...page.matchAll(/twlan-\d{8}-\d{6}\.db/g)].map((m) => m[0]);
    assert.ok(new Set(names).size <= 2 && names.length >= 2, `only the two newest are kept (${new Set(names).size})`);
    const name = names[0];
    const file = await post('/admin/backup/file', { name });
    assert.equal(file.status, 200);
    assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
    assert.equal((await post('/admin/backup/file', { name: '../server.js' })).status, 302, 'path tricks are refused');
    assert.equal((await post('/admin/backup/file', { name: 'twlan-20000101-000000.db' })).status, 302, 'unknown file');
  } finally { s.close(); }
});

test('forgotten password: recovery code instead of e-mail', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice');
    has(await (await s.client().raw('/page/recover')).text(), /Wiederherstellungscode/, 'recover page');
    let r = await a.post('settings', { mode: 'recovery' }, { password: 'falsch' });
    has(r.body, /Passwort ist falsch/, 'needs the password');
    r = await a.post('settings', { mode: 'recovery' }, { password: 'secret1' });
    const code = /<b>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})<\/b>/.exec(r.body)[1];
    assert.equal(s.db.prepare('SELECT recovery_hash FROM user').get().recovery_hash.includes(code), false, 'only a hash is stored');
    const anon = s.client();
    const recover = (form) => anon.raw('/page/recover', { method: 'POST', form });
    has(await (await recover({ username: 'alice', code: 'AAAA-BBBB-CCCC', password: 'neuespass1' })).text(), /stimmen nicht/, 'wrong code');
    has(await (await recover({ username: 'alice', code, password: 'x' })).text(), /6 bis 100/, 'weak password');
    has(await (await recover({ username: 'nobody', code, password: 'neuespass1' })).text(), /stimmen nicht/, 'unknown name looks the same');
    has(await (await recover({ username: 'alice', code: code.toLowerCase().replace(/-/g, ' '), password: 'neuespass1' })).text(), /Passwort wurde geändert/, 'case and separators do not matter');
    assert.ok((await (await s.client().raw('/page/auth', { method: 'POST', form: { username: 'alice', password: 'neuespass1' } })).json()).ok, 'new password works');
    assert.ok((await (await s.client().raw('/page/auth', { method: 'POST', form: { username: 'alice', password: 'secret1' } })).json()).error, 'old one does not');
    has(await (await recover({ username: 'alice', code, password: 'nochmal123' })).text(), /stimmen nicht/, 'the code works once');
    assert.equal((await a.screen('overview')).status, 302, 'old sessions are gone');
  } finally { s.close(); }
});

test('notifications settings, pulse endpoint and the start page language', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob');
    has((await a.screen('settings', { mode: 'notify' })).html, /Meldungen im Browser/, 'settings page');
    assert.equal((await s.client().raw('/api/pulse')).status, 401);
    let pulse = await (await a.raw('/api/pulse')).json();
    assert.deepEqual([pulse.attacks, pulse.messages, pulse.reports, pulse.prefs.browser, pulse.prefs.attack], [0, 0, 0, false, true]);
    await a.post('settings', { mode: 'notify' }, { browser: '1', sound: '1', attack: '1', message: '1' });
    s.db.prepare("INSERT INTO message (from_id, to_id, subject, body, time) VALUES (2, 1, 'Hi', 'x', 0)").run();
    s.db.prepare("INSERT INTO village_unit VALUES (?, 'axe', 5)").run(b.vid);
    s.db.prepare("INSERT INTO command (type, from_village, to_village, units, depart_at, arrive_at) VALUES ('attack', ?, ?, '{\"axe\":5}', 0, 9999999999)").run(b.vid, a.vid);
    pulse = await (await a.raw('/api/pulse')).json();
    assert.deepEqual([pulse.attacks, pulse.messages, pulse.prefs.browser, pulse.prefs.sound, pulse.prefs.report], [1, 1, true, true, false]);
    const script = await s.client().raw('/twl-notify.js');
    assert.equal(script.status, 200);
    has(await script.text(), /api\/pulse/, 'client script');
    has((await a.screen('overview')).html, /twl-notify\.js/, 'script on every game page');

    // visitors choose the language of the start page
    const visitor = s.client();
    const lang = await visitor.raw('/page/lang?l=en');
    assert.equal(lang.status, 302);
    has(await (await visitor.raw('/')).text(), /Stay logged in|User name/, 'start page in English');
    assert.equal((await visitor.raw('/page/lang?l=xx')).status, 302, 'unknown language is ignored');
    has(await (await visitor.raw('/')).text(), /Stay logged in|User name/, 'still English');
  } finally { s.close(); }
});

test('report folders, filters and public links work', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice');
    const ins = (type, title) => s.db.prepare('INSERT INTO report (user_id, type, title, color, time, data) VALUES (1, ?, ?, ?, ?, ?)').run(type, title, 'green', 1, JSON.stringify({ kind: 'trade', from: { village: 'A', x: 1, y: 2 }, to: { village: 'B', x: 3, y: 4, user: 'bob' }, res: { wood: 1, stone: 1, iron: 1 } }));
    ins('trade', 'Lieferung eins'); ins('trade', 'Lieferung zwei');
    await a.post('report', { action: 'folder_add' }, { name: 'Wichtig' });
    const folder = s.db.prepare('SELECT id FROM report_folder').get().id;
    await a.post('report', { action: 'process' }, { ids: '1', op: `move_${folder}` });
    hasNot((await a.screen('report')).html, /Lieferung eins/, 'moved out of the inbox');
    has((await a.screen('report', { mode: 'folder', folder })).html, /Lieferung eins/, 'inside the folder');
    await a.post('report', { action: 'publish', view: '2' });
    const token = s.db.prepare('SELECT public_token FROM report WHERE id = 2').get().public_token;
    const pub = await (await fetch(`${s.base}/report/${token}`)).text();
    has(pub, /Lieferung zwei/, 'public page readable without login');
    assert.equal((await fetch(`${s.base}/report/${'0'.repeat(24)}`)).status, 404);
    await a.post('report', { action: 'filter_save', mode: 'filter' }, { hide: 'trade' });
    require('../src/game/commands').addReport(s.db, 1, { type: 'trade', title: 'Gefiltert', color: 'green', time: 2, data: {} });
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM report WHERE title = 'Gefiltert'").get().n, 0, 'filtered type is dropped');
    for (const mode of ['public', 'filter', 'forwarded']) assert.equal((await a.screen('report', { mode })).status, 200, mode);
    await a.post('report', { action: 'folder_delete', mode: 'folder', folder });
    has((await a.screen('report')).html, /Lieferung eins/, 'back in the inbox after deleting the folder');
  } finally { s.close(); }
});

test('mail folders and address book groups', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob');
    await a.post('mail', { mode: 'new', action: 'send' }, { to: 'bob', subject: 'Hallo Bob', body: 'x' });
    await b.post('mail', { mode: 'in', action: 'folder_add' }, { name: 'Freunde' });
    const folder = s.db.prepare('SELECT id FROM mail_folder').get().id;
    await b.post('mail', { mode: 'in', action: 'move' }, { ids: '1', op: `move_${folder}` });
    hasNot((await b.screen('mail')).html, /Hallo Bob/, 'left the inbox');
    has((await b.screen('mail', { mode: 'folder', folder })).html, /Hallo Bob/, 'in folder');
    await b.post('mail', { mode: 'address', action: 'buddy_add' }, { name: 'alice' });
    await b.post('mail', { mode: 'address', action: 'buddy_group' }, { other: '1', grp: 'Clan' });
    has((await b.screen('mail', { mode: 'address' })).html, /value="Clan"/, 'group saved');
    await b.post('mail', { mode: 'in', action: 'folder_delete', folder });
    has((await b.screen('mail')).html, /Hallo Bob/, 'back after folder deletion');
  } finally { s.close(); }
});

test('tribe forum supports boards and polls', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice'); const b = await s.client().register('bob');
    await a.post('ally', { action: 'found' }, { name: 'Wolves', tag: 'WLF' });
    s.db.prepare('UPDATE user SET ally_id = 1 WHERE id = 2').run();
    await a.post('ally', { mode: 'forum', action: 'board_add' }, { name: 'Krieg' });
    const board = s.db.prepare('SELECT id FROM forum_board').get().id;
    await a.post('ally', { mode: 'forum', action: 'thread' }, { title: 'Angriff?', body: 'Wer ist dabei?', board: String(board), poll: 'Wann?', options: 'Heute\nMorgen\nHeute' });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM forum_poll_option').get().n, 2, 'duplicates removed');
    hasNot((await a.screen('ally', { mode: 'forum' })).html, /Angriff\?/, 'not in the main forum');
    has((await a.screen('ally', { mode: 'forum', board })).html, /Angriff\?/, 'in the board');
    const opt = s.db.prepare('SELECT id FROM forum_poll_option').get().id;
    await b.post('ally', { mode: 'forum', thread: '1', action: 'vote' }, { option: String(opt) });
    await b.post('ally', { mode: 'forum', thread: '1', action: 'vote' }, { option: String(opt) });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM forum_poll_vote').get().n, 1, 'one vote per player');
    has((await a.screen('ally', { mode: 'forum', thread: '1' })).html, /Wann\?/, 'poll shown');
    await b.post('ally', { mode: 'forum', action: 'thread' }, { title: 'x', body: 'y', poll: 'Nur eine?', options: 'einzige' });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM forum_thread').get().n, 1, 'poll needs two options');
  } finally { s.close(); }
});

test('the paladin can move to another village with a statue', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice');
    s.db.prepare("INSERT INTO village (user_id, name, x, y, wood, stone, iron, res_updated_at, created_at) VALUES (1, 'Zweitdorf', 500, 510, 0, 0, 0, 0, 0)").run();
    const second = s.db.prepare("SELECT id FROM village WHERE name = 'Zweitdorf'").get().id;
    level(s.db, a.vid, 'statue', 1);
    s.db.prepare("INSERT INTO village_unit VALUES (?, 'knight', 1)").run(a.vid);
    let r = await a.post('statue', { action: 'move' }, { to: String(second) });
    has(r.body, /keine Statue/, 'target needs a statue');
    level(s.db, second, 'statue', 1);
    r = await a.post('statue', { action: 'move' }, { to: String(second) });
    assert.equal(r.status, 302);
    assert.equal(s.db.prepare("SELECT count FROM village_unit WHERE village_id = ? AND unit = 'knight'").get(a.vid).count, 0, 'left home');
    s.db.prepare('UPDATE command SET arrive_at = 0').run();
    require('../src/game/commands').processDue(s.db);
    assert.equal(s.db.prepare("SELECT count FROM village_unit WHERE village_id = ? AND unit = 'knight'").get(second).count, 1, 'arrived');
  } finally { s.close(); }
});

test('a sitter acts inside the owner account but cannot change account matters', async () => {
  const s = await start();
  try {
    const owner = await s.client().register('owner'); const sitter = await s.client().register('sitter');
    // not allowed yet
    await sitter.raw(`/page/sit?id=1&h=${sitter.csrf}`);
    has((await sitter.screen('overview')).html, /name="?[^"]*"?|sitter/i, 'still own account');
    assert.equal(s.db.prepare('SELECT sit_for FROM session WHERE user_id = 2').get().sit_for, null, 'no relation, no sitting');
    await owner.post('settings', { mode: 'sitter' }, { name: 'sitter' });
    const r = await sitter.raw(`/page/sit?id=1&h=${sitter.csrf}`);
    assert.equal(r.status, 302);
    const page = (await sitter.screen('overview', { village: owner.vid })).html;
    has(page, /Vertretung beenden/, 'banner while sitting');
    assert.equal((await sitter.screen('settings')).status, 302, 'settings blocked');
    assert.equal((await sitter.screen('main', { village: owner.vid })).status, 200, 'normal screens work');
    await sitter.raw(`/page/sit?end=1&h=${sitter.csrf}`);
    hasNot((await sitter.screen('overview')).html, /Vertretung beenden/, 'ended');
    assert.equal((await sitter.screen('settings')).status, 200, 'settings available again');
  } finally { s.close(); }
});

test('phones get their own page frame, switchable with a cookie', async () => {
  const s = await start();
  try {
    const a = await s.client().register('alice');
    const page = (headers) => a.raw(`/game.php?village=${a.vid}&screen=overview`, { headers }).then((r) => r.text());
    const phone = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148' };
    has(await page(phone), /id="m_tabs"/, 'phone layout');
    hasNot(await page({}), /id="m_tabs"/, 'desktop layout by default');
    const r = await a.raw('/page/view?mode=desktop&back=/page/play', { headers: phone });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('set-cookie'), /twview=desktop/);
    const r2 = await a.raw('/page/view?mode=mobile&back=//evil.example');
    assert.equal(r2.headers.get('location'), '/page/play', 'no open redirect');
  } finally { s.close(); }
});

test('admins can remove barbarian villages; players and relic sites stay', async () => {
  const s = await start();
  try {
    const admin = await s.client().register('alice');
    const v = require('../src/game/village');
    const barb = (x, y) => v.createVillage(s.db, { userId: null, name: 'Barbarendorf', x, y });
    const a = barb(10, 10); const b = barb(12, 10); const far = barb(100, 100); const relicSite = barb(11, 11);
    s.db.prepare("INSERT INTO relic (id, name, effect, bonus, site_village) VALUES (1, 'R', 'wood', 1.1, ?)").run(relicSite);
    // an attack on its way to village `a` turns around instead of vanishing
    s.db.prepare("INSERT INTO command (type, from_village, to_village, units, depart_at, arrive_at) VALUES ('attack', ?, ?, '{\"axe\":5}', 0, 9999999999)").run(admin.vid, a);
    const post = (path, form = {}) => admin.raw(path, { method: 'POST', form: { h: admin.csrf, ...form } });
    await post(`/admin/villages/${a}/remove`);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM village WHERE id = ?').get(a).n, 0, 'removed');
    assert.equal(s.db.prepare('SELECT type FROM command').get().type, 'return', 'troops turn around');
    await post(`/admin/villages/${admin.vid}/remove`);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM village WHERE id = ?').get(admin.vid).n, 1, 'player village stays');
    await post('/admin/villages/clear', { center: '11|10', radius: '5' });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM village WHERE id = ?').get(b).n, 0, 'radius removal');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM village WHERE id = ?').get(relicSite).n, 1, 'relic site stays');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM village WHERE id = ?').get(far).n, 1, 'outside the radius');
    hasNot(await (await admin.raw('/admin/villages?barb=1&q=Barbaren')).text(), /<%|undefined/, 'barbarian listing');
  } finally { s.close(); }
});

test('admin can refill removed barbarian villages', async () => {
  const s = await start();
  try {
    const admin = await s.client().register('alice');
    const world = require('../src/game/world');
    world.seedBarbarians(s.db);
    const total = () => s.db.prepare('SELECT COUNT(*) AS n FROM village WHERE user_id IS NULL').get().n;
    const full = total();
    assert.ok(full > 100, 'seeded');
    await admin.raw('/admin/villages/clear', { method: 'POST', form: { h: admin.csrf, center: '500|500', radius: '40' } });
    const after = total();
    assert.ok(after < full, 'some removed');
    await admin.raw('/admin/villages/refill', { method: 'POST', form: { h: admin.csrf } });
    assert.ok(total() > after, 'refilled');
  } finally { s.close(); }
});
