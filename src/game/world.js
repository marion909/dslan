'use strict';
const cfg = require('../config');
const f = require('./formulas');
const v = require('./village');
const { transaction } = require('../db');

const CENTER = cfg.world.mapSize / 2;
// Barbarian villages only exist near the middle where players start.
const BARB_RADIUS = Number(process.env.TW_BARB_RADIUS || 120);

// Small seeded PRNG so terrain and barbarians are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash2 = (x, y, salt) => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// Value noise: smooth blobs for forests, mountains and lakes.
function noise(x, y, scale, salt) {
  const gx = x / scale; const gy = y / scale;
  const x0 = Math.floor(gx); const y0 = Math.floor(gy);
  const fx = gx - x0; const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx); const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, salt); const b = hash2(x0 + 1, y0, salt);
  const c = hash2(x0, y0 + 1, salt); const d = hash2(x0 + 1, y0 + 1, salt);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// The forest tiles are dense tree patches and the lake tile is one small pond, so the land is
// mostly grass with scattered tree clumps, single ponds and a few hills.
const smooth = (x, y, salt) => 0.65 * noise(x, y, 5, salt) + 0.35 * noise(x, y, 2.4, salt + 7);
const isForest = (x, y) => smooth(x, y, 11) > 0.635 && hash2(x, y, 41) > 0.07;
const isPond = (x, y) => hash2(x, y, 23) < 0.012 && !isForest(x, y);
const isHill = (x, y) => hash2(x, y, 37) < 0.035 && !isForest(x, y) && !isPond(x, y);

// Indices into TWMap.images (map.js): 0-3 grass, 28-31 hills, 32-47 forest variants, 48 pond.
function tileImage(x, y) {
  if (isPond(x, y)) return 48;
  if (isForest(x, y)) return 32 + Math.floor(hash2(x, y, 9) * 16);
  if (isHill(x, y)) return 28 + Math.floor(hash2(x, y, 5) * 4);
  return Math.floor(hash2(x, y, 3) * 4);
}

// Village sprite size grows with points (thresholds come from world.json).
function villageImage(points, barbarian) {
  const steps = Object.entries(cfg.villageImages).map(([k, val]) => [Number(k.replace('img_', '')), Number(val)]).sort((a, b) => a[0] - b[0]);
  let size = 1;
  for (const [from, n] of steps) if (points >= from) size = n;
  // images: 4+2*(n-1) is v<n>_left, +1 the regular one; barbarians start at 16.
  return (barbarian ? 16 : 4) + 2 * (size - 1) + 1;
}

const isBuildable = (x, y) => !isPond(x, y) && !isForest(x, y);

function occupied(db, x, y) {
  return !!db.prepare('SELECT 1 FROM village WHERE x = ? AND y = ?').get(x, y);
}

// Creates barbarian villages once; later starts keep the existing ones.
// `refill` (admin) fills every free buildable spot again with the original density, e.g. after a clean-up went too far.
function seedBarbarians(db, { refill = false } = {}) {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'barbarians_seeded'").get();
  if (!refill && done && done.value === '2') return 0;
  const topUp = !refill && !!done;
  const rnd = mulberry32(topUp ? 7331 : 1337);
  const density = cfg.world.mapDensity / 100;
  let count = 0;
  transaction(db, () => {
    for (let x = CENTER - BARB_RADIUS; x < CENTER + BARB_RADIUS; x++) {
      for (let y = CENTER - BARB_RADIUS; y < CENTER + BARB_RADIUS; y++) {
        if (rnd() > density * (topUp ? 3 : 6) || !isBuildable(x, y) || occupied(db, x, y)) continue;
        const id = v.createVillage(db, { userId: null, name: 'Barbarendorf', x, y });
        // Random development, with the headquarters always present.
        const scale = 0.15 + rnd() * 0.55;
        for (const b of f.BUILDING_IDS) {
          const max = cfg.buildings[b].maxLevel;
          const level = b === 'main' ? Math.max(1, Math.round(max * scale)) : Math.round(max * scale * rnd());
          if (level > 0 || cfg.buildings[b].startLevel > 0) {
            db.prepare('INSERT INTO village_building (village_id, building, level) VALUES (?,?,?) ON CONFLICT(village_id, building) DO UPDATE SET level = excluded.level')
              .run(id, b, Math.min(Math.max(level, cfg.buildings[b].minLevel), max));
          }
        }
        count++;
      }
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('barbarians_seeded', '2') ON CONFLICT(key) DO UPDATE SET value = '2'").run();
  });
  return count;
}

// Barbarians defend themselves in proportion to how developed they are.
function giveBarbarianTroops(db) {
  const rnd = mulberry32(4242);
  let count = 0;
  transaction(db, () => {
    const bare = db.prepare('SELECT id FROM village WHERE user_id IS NULL AND id NOT IN (SELECT village_id FROM village_unit)').all();
    for (const r of bare) {
      const main = v.getBuildings(db, r.id).main;
      const army = { spear: Math.round(main * rnd() * 5), sword: Math.round(main * rnd() * 3), axe: Math.round(main * rnd() * 2) };
      for (const [unit, n] of Object.entries(army)) {
        if (n > 0) db.prepare('INSERT INTO village_unit (village_id, unit, count) VALUES (?,?,?) ON CONFLICT(village_id, unit) DO UPDATE SET count = excluded.count').run(r.id, unit, n);
      }
      count++;
    }
  });
  return count;
}

// Free spot for a new player: ring search outwards from the middle.
// direction: random | nw | no | sw | so (north is smaller y) | ally (next to a tribe mate).
const DIRECTIONS = ['random', 'nw', 'no', 'sw', 'so', 'ally'];

function pickSpot(db, { direction = 'random', allyId = null } = {}) {
  let cx = CENTER; let cy = CENTER; let startRing = 5;
  if (direction === 'ally' && allyId) {
    const mate = db.prepare('SELECT v.x, v.y FROM village v JOIN user u ON u.id = v.user_id WHERE u.ally_id = ? ORDER BY RANDOM() LIMIT 1').get(allyId);
    if (mate) { cx = mate.x; cy = mate.y; startRing = 2; }
  }
  const inQuadrant = (x, y) => (direction === 'nw' ? x < CENTER && y < CENTER : direction === 'no' ? x > CENTER && y < CENTER
    : direction === 'sw' ? x < CENTER && y > CENTER : direction === 'so' ? x > CENTER && y > CENTER : true);
  for (let ring = startRing; ring < CENTER; ring += 1) {
    for (let tries = 0; tries < 40; tries++) {
      const x = cx + Math.floor((Math.random() * 2 - 1) * ring);
      const y = cy + Math.floor((Math.random() * 2 - 1) * ring);
      if (x < 0 || y < 0 || x >= 2 * CENTER || y >= 2 * CENTER) continue;
      if (isBuildable(x, y) && !occupied(db, x, y) && inQuadrant(x, y) && Math.hypot(x - cx, y - cy) > 3) return { x, y };
    }
  }
  throw new Error('map is full');
}

// One 20x20 sector in the format the original map script expects.
function sector(db, sx, sy, flags) {
  const villages = {}; const players = {}; const allies = {};
  const rows = db.prepare(
    'SELECT v.id, v.name, v.x, v.y, v.user_id, u.name AS owner FROM village v LEFT JOIN user u ON u.id = v.user_id '
    + 'WHERE v.x >= ? AND v.x < ? AND v.y >= ? AND v.y < ?',
  ).all(sx, sx + 20, sy, sy + 20);
  for (const r of rows) {
    const levels = v.getBuildings(db, r.id);
    const points = v.villagePoints(levels);
    (villages[r.x - sx] ||= {})[r.y - sy] = [r.id, villageImage(points, !r.user_id), r.user_id ? r.name : 0, points, r.user_id || 0, 100, 0, 0];
    if (r.user_id && !players[r.user_id]) {
      const pts = db.prepare('SELECT id FROM village WHERE user_id = ?').all(r.user_id)
        .reduce((s, x) => s + v.villagePoints(v.getBuildings(db, x.id)), 0);
      const owner = db.prepare('SELECT ally_id, created_at FROM user WHERE id = ?').get(r.user_id);
      // [name, points, tribe, protection hours left, asleep, picture]
      const left = Math.max(0, owner.created_at + cfg.PROTECTION_SECONDS - Date.now() / 1000);
      players[r.user_id] = [r.owner, pts, owner.ally_id || 0, left > 0 ? Math.ceil(left / 3600) : 0, 0, 0];
      if (owner.ally_id && !allies[owner.ally_id]) {
        const a = db.prepare('SELECT name, tag FROM ally WHERE id = ?').get(owner.ally_id);
        allies[owner.ally_id] = [a.name, 0, a.tag, 0];
      }
    }
  }
  const out = { data: { x: sx, y: sy, villages, players, allies } };
  if (flags & 1) {
    const tiles = [];
    for (let x = 0; x < 20; x++) { tiles[x] = []; for (let y = 0; y < 20; y++) tiles[x][y] = tileImage(sx + x, sy + y); }
    out.tiles = tiles;
  }
  if (flags & 2) out.pmap = [[], []];
  return out;
}

// Admin tool: takes barbarian villages off the map. Villages of players and relic sites stay.
// Troops that were still on their way there turn around instead of vanishing with the village.
function removeBarbarians(db, ids) {
  const out = { removed: 0, skipped: 0 };
  const now = Date.now() / 1000;
  transaction(db, () => {
    for (const id of ids) {
      const row = db.prepare('SELECT id, user_id FROM village WHERE id = ?').get(id);
      if (!row || row.user_id || db.prepare('SELECT 1 FROM relic WHERE site_village = ?').get(id)) { out.skipped++; continue; }
      for (const c of db.prepare("SELECT id, from_village FROM command WHERE to_village = ? AND type IN ('attack', 'support')").all(id)) {
        db.prepare("UPDATE command SET type = 'return', to_village = from_village, arrive_at = ?, depart_at = ? WHERE id = ?").run(now, now, c.id);
      }
      db.prepare('DELETE FROM village WHERE id = ?').run(id);
      out.removed++;
    }
  });
  return out;
}

module.exports = { removeBarbarians, DIRECTIONS, giveBarbarianTroops, seedBarbarians, pickSpot, sector, tileImage, isBuildable, CENTER, villageImage };
