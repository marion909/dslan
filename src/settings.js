'use strict';
const cfg = require('./config');

// Settings an admin can change while the server runs; stored in the database and applied to the shared config.
const DEFAULTS = {
  speedMultiplier: cfg.SPEED_MULT, registration: 'open',
  backupEnabled: '1', backupHours: '24', backupKeep: '7',
  botCount: '0', botActive: '1', botInterval: '30', botAggression: '3', botAttackPlayers: '1', botMark: '0',
};

function load(db) {
  const rows = Object.fromEntries(db.prepare('SELECT key, value FROM setting').all().map((r) => [r.key, r.value]));
  return { ...DEFAULTS, ...rows };
}

function apply(db) {
  const s = load(db);
  const mult = Math.min(1000, Math.max(0.1, Number(s.speedMultiplier) || 1));
  cfg.SPEED_MULT = mult;
  cfg.SPEED = (cfg.world.speed / 1000) * mult;
  cfg.PROTECTION_SECONDS = (cfg.world.beginnerProtection * 60) / mult;
  return s;
}

function set(db, key, value) {
  db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  return apply(db);
}

const registrationOpen = (db) => load(db).registration !== 'closed';

module.exports = { load, apply, set, registrationOpen };
