'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const settings = require('../src/settings');
const bots = require('../src/game/bots');
const world = require('../src/game/world');
const village = require('../src/game/village');
const units = require('../src/game/units');

// A small seeded PRNG keeps the simulation repeatable.
function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Runs `fn` with a clock that only moves when the test says so.
function withClock(fn) {
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  try { return fn((seconds) => { now += seconds * 1000; }); } finally { Date.now = real; }
}

test('the bot count follows the setting; bots are real users that cannot log in', () => {
  const db = open(':memory:');
  assert.deepEqual(bots.sync(db, 5, seeded(1)), { created: 5, removed: 0, total: 5 });
  const list = bots.list(db);
  assert.equal(list.length, 5);
  assert.equal(new Set(list.map((b) => b.name)).size, 5, 'unique names');
  for (const b of list) assert.equal(b.villages, 1);
  assert.ok(db.prepare('SELECT is_bot FROM user').all().every((u) => u.is_bot === 1));
  assert.deepEqual(bots.sync(db, 2, seeded(2)), { created: 0, removed: 3, total: 2 });
  assert.equal(bots.list(db).length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM village WHERE user_id IS NOT NULL').get().n, 2);
  assert.equal(bots.sync(db, 0).removed, 2);
  settings.set(db, 'botMark', '1');
  bots.sync(db, 1, seeded(3));
  assert.match(bots.list(db)[0].name, /\[Bot\]$/, 'optional marker');
  assert.equal(bots.sync(db, 9999).total, 200, 'capped');
});

test('bots build, recruit, research, fight, trade and socialise like players', { timeout: 120000 }, () => {
  withClock((advance) => {
    const db = open(':memory:');
    world.seedBarbarians(db); world.giveBarbarianTroops(db);
    settings.set(db, 'botInterval', '2');
    const rng = seeded(42);
    bots.sync(db, 8, rng);
    const levelSum = () => db.prepare('SELECT COALESCE(SUM(level), 0) AS n FROM village_building WHERE village_id IN (SELECT id FROM village WHERE user_id IN (SELECT user_id FROM bot))').get().n;
    const baseline = levelSum();
    let errors = 0;
    const realError = console.error; console.error = () => { errors++; };
    try {
      for (let step = 0; step < 900; step++) { advance(45); bots.tick(db, Date.now() / 1000, rng, 50); }
    } finally { console.error = realError; }
    assert.equal(errors, 0, 'no bot turn failed');

    const levels = db.prepare("SELECT MAX(level) AS m FROM village_building WHERE building = 'main'").get().m;
    assert.ok(levels >= 10, `headquarters grew (${levels})`);
    assert.ok(levelSum() > baseline + 150, `many building levels were added (${baseline} -> ${levelSum()})`);
    const troops = db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM village_unit WHERE village_id IN (SELECT id FROM village WHERE user_id IN (SELECT user_id FROM bot))").get().n;
    assert.ok(troops > 100, `an army exists (${troops})`);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM village_research WHERE village_id IN (SELECT id FROM village WHERE user_id IN (SELECT user_id FROM bot))').get().n > 0, 'research finished');
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM bot_log').get().n > 100, 'actions are logged for the admin');
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM report WHERE user_id IN (SELECT user_id FROM bot) AND type = 'attack'").get().n > 0, 'battle or spy reports exist');
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM ally').get().n >= 1, 'a tribe was founded');
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM user WHERE is_bot = 1 AND ally_id IS NOT NULL').get().n >= 2, 'bots joined tribes');
    // pop limit is respected like for everyone
    for (const v of db.prepare('SELECT id FROM village WHERE user_id IN (SELECT user_id FROM bot)').all()) {
      const lv = village.getBuildings(db, v.id);
      assert.ok(village.popUsed(lv, village.getQueue(db, v.id), village.unitPop(db, v.id)) <= village.popMax(lv) + 1, 'population limit');
    }
    // summary for the admin
    const summary = bots.list(db);
    assert.equal(summary.length, 8);
    console.log('       bot log lines:', db.prepare('SELECT COUNT(*) AS n FROM bot_log').get().n, '| troops:', troops, '| tribes:', db.prepare('SELECT COUNT(*) AS n FROM ally').get().n,
      '| conquered:', db.prepare('SELECT SUM(conquered) AS n FROM user').get().n, '| top points:', Math.max(...summary.map((b) => b.points)));
  });
});

test('bots answer messages, accept applications and help tribe mates', () => {
  withClock((advance) => {
    const db = open(':memory:');
    bots.sync(db, 3, seeded(7));
    const [a, b, c] = bots.list(db).map((x) => x.user_id);
    db.prepare("INSERT INTO user (name, password_hash, created_at) VALUES ('Mensch', 'x', 0)").run();
    const human = db.prepare("SELECT id FROM user WHERE name = 'Mensch'").get().id;
    db.prepare("INSERT INTO message (from_id, to_id, subject, body, time) VALUES (?,?,?,?,?)").run(human, a, 'Hallo', 'Wie geht es?', Math.floor(Date.now() / 1000));
    const rng = seeded(9);
    bots.act(db, db.prepare('SELECT * FROM bot WHERE user_id = ?').get(a), rng);
    const reply = db.prepare('SELECT subject, to_id FROM message WHERE from_id = ?').get(a);
    assert.deepEqual([reply.subject, reply.to_id], ['Re: Hallo', human]);
    assert.equal(db.prepare('SELECT is_read FROM message WHERE from_id = ?').get(human).is_read, 1);

    // tribe: a founds, b applies, a decides on its next turn
    const ally = require('../src/game/ally');
    const ua = db.prepare('SELECT * FROM user WHERE id = ?').get(a);
    ally.found(db, ua, 'Testbund', 'TST');
    ally.apply(db, db.prepare('SELECT * FROM user WHERE id = ?').get(b), 1, 'bitte');
    for (let i = 0; i < 6; i++) { advance(10); bots.act(db, db.prepare('SELECT * FROM bot WHERE user_id = ?').get(a), rng); }
    assert.equal(db.prepare('SELECT ally_id FROM user WHERE id = ?').get(b).ally_id, 1);
    void c; void units;
  });
});
