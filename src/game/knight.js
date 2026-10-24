'use strict';
const cfg = require('../config');
const fs = require('node:fs');
const path = require('node:path');

const items = JSON.parse(fs.readFileSync(path.join(cfg.ROOT, 'config/worlds/world/knight_items.json'), 'utf8'));
const system = items.systems[cfg.world.knightItems] || items.systems.simple;
const ITEM_IDS = Object.keys(system);
const POLY = items.poly;

const found = (db, userId) => db.prepare('SELECT item FROM knight_item WHERE user_id = ?').all(userId).map((r) => r.item);

function equipped(db, userId) {
  const row = db.prepare('SELECT knight_item FROM user WHERE id = ?').get(userId);
  return row && row.knight_item && found(db, userId).includes(row.knight_item) ? row.knight_item : '';
}

function equip(db, userId, item) {
  if (item !== '' && !found(db, userId).includes(item)) return { ok: false, error: 'noItem' };
  db.prepare('UPDATE user SET knight_item = ? WHERE id = ?').run(item, userId);
  return { ok: true };
}

// Multipliers for the troops that travel with (or are defended by) the knight.
function boostFor(db, userId) {
  const item = userId ? equipped(db, userId) : '';
  if (!item) return {};
  const s = system[item];
  return { [item]: { att: s.att, def: s.def } };
}

// Every battle the knight takes part in brings the next find closer.
function gainProgress(db, userId) {
  if (!userId) return null;
  const row = db.prepare('SELECT knight_progress FROM user WHERE id = ?').get(userId);
  let progress = (row ? row.knight_progress : 0) + cfg.world.knightItemProgress;
  let newItem = null;
  if (progress >= 100) {
    const have = found(db, userId);
    const left = ITEM_IDS.filter((i) => !have.includes(i));
    if (left.length) {
      newItem = left[Math.floor(Math.random() * left.length)];
      db.prepare('INSERT OR IGNORE INTO knight_item (user_id, item) VALUES (?,?)').run(userId, newItem);
    }
    progress -= 100;
  }
  db.prepare('UPDATE user SET knight_progress = ? WHERE id = ?').run(progress, userId);
  return newItem;
}

const progress = (db, userId) => (db.prepare('SELECT knight_progress FROM user WHERE id = ?').get(userId) || { knight_progress: 0 }).knight_progress;

module.exports = { ITEM_IDS, POLY, system, found, equipped, equip, boostFor, gainProgress, progress };
