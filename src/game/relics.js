'use strict';
const cfg = require('../config');
const { transaction } = require('../db');

// Each relic sits in one village. Whoever owns that village can hand the relic's power to one of
// their own villages within this many fields; losing either village ends the effect.
const RADIUS = 30;

const EFFECTS = {
  wood: { label: 'Holzproduktion' }, stone: { label: 'Lehmproduktion' }, iron: { label: 'Eisenproduktion' },
  defense: { label: 'Verteidigung' }, attack: { label: 'Angriffsstärke' },
};

const CATALOG = [
  ['Splitter des Heiligen Speers', 'defense', 20], ['Kelch des Wanderers', 'wood', 25], ['Krone der Nordlichter', 'attack', 15],
  ['Amulett der Schmiede', 'iron', 25], ['Stein der Ahnen', 'stone', 25], ['Banner des Königs', 'defense', 25],
];

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function list(db) {
  return db.prepare(`SELECT r.*, s.name AS site_name, s.x AS site_x, s.y AS site_y, s.user_id AS owner_id, u.name AS owner, a.tag AS owner_tag,
      t.name AS target_name, t.x AS target_x, t.y AS target_y
    FROM relic r JOIN village s ON s.id = r.site_village LEFT JOIN user u ON u.id = s.user_id LEFT JOIN ally a ON a.id = u.ally_id
    LEFT JOIN village t ON t.id = r.assigned_village ORDER BY r.id`).all();
}

// Relics whose site belongs to the player.
const mine = (db, userId) => list(db).filter((r) => r.owner_id === userId);

function assign(db, userId, relicId, villageId) {
  return transaction(db, () => {
    const relic = db.prepare('SELECT r.*, s.user_id AS owner_id, s.x, s.y FROM relic r JOIN village s ON s.id = r.site_village WHERE r.id = ?').get(relicId);
    if (!relic || relic.owner_id !== userId) return { ok: false, error: 'notYours' };
    if (villageId === null) { db.prepare('UPDATE relic SET assigned_village = NULL WHERE id = ?').run(relicId); return { ok: true }; }
    const target = db.prepare('SELECT * FROM village WHERE id = ? AND user_id = ?').get(villageId, userId);
    if (!target) return { ok: false, error: 'noVillage' };
    if (distance(relic, target) > RADIUS) return { ok: false, error: 'tooFar' };
    db.prepare('UPDATE relic SET assigned_village = ? WHERE id = ?').run(villageId, relicId);
    return { ok: true };
  });
}

// Multipliers granted to one village, e.g. { wood: 1.25, defense: 1.2 }. Stale assignments count for nothing.
function boostFor(db, villageId) {
  const rows = db.prepare(`SELECT r.effect, r.bonus FROM relic r JOIN village s ON s.id = r.site_village JOIN village t ON t.id = r.assigned_village
    WHERE r.assigned_village = ? AND s.user_id IS NOT NULL AND s.user_id = t.user_id`).all(villageId);
  const out = {};
  for (const r of rows) out[r.effect] = (out[r.effect] || 1) + r.bonus / 100;
  return out;
}

// A village changed hands: relics lose their link to it.
function villageLost(db, villageId) {
  db.prepare('UPDATE relic SET assigned_village = NULL WHERE site_village = ? OR assigned_village = ?').run(villageId, villageId);
}

// Places the relics once, in barbarian villages spread around the middle of the world.
function seed(db) {
  if (db.prepare("SELECT 1 FROM meta WHERE key = 'relics_seeded'").get()) return 0;
  const c = cfg.world.mapSize / 2;
  const candidates = db.prepare('SELECT id, x, y FROM village WHERE user_id IS NULL').all()
    .filter((v) => { const d = Math.hypot(v.x - c, v.y - c); return d >= 18 && d <= 95; });
  const chosen = [];
  for (let i = 0; i < CATALOG.length; i++) {
    // pick the candidate on a different bearing each time so the relics are far apart
    const angle = (i / CATALOG.length) * 2 * Math.PI;
    let best = null; let bestScore = Infinity;
    for (const v of candidates) {
      if (chosen.some((o) => distance(o, v) < 25)) continue;
      const score = Math.abs(Math.atan2(v.y - c, v.x - c) - (angle - Math.PI)) + Math.abs(Math.hypot(v.x - c, v.y - c) - 55) / 200;
      if (score < bestScore) { bestScore = score; best = v; }
    }
    if (best) chosen.push(best);
  }
  transaction(db, () => {
    chosen.forEach((v, i) => db.prepare('INSERT INTO relic (name, effect, bonus, site_village) VALUES (?,?,?,?)').run(CATALOG[i][0], CATALOG[i][1], CATALOG[i][2], v.id));
    db.prepare("INSERT INTO meta (key, value) VALUES ('relics_seeded', '1')").run();
  });
  return chosen.length;
}

module.exports = { RADIUS, EFFECTS, list, mine, assign, boostFor, villageLost, seed, distance };
