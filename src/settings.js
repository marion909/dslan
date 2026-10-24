'use strict';
const cfg = require('./config');

// Settings an admin can change while the server runs; stored in the database and applied to the shared config.
const DEFAULTS = {
  speedMultiplier: cfg.SPEED_MULT, registration: 'open',
  backupEnabled: '1', backupHours: '24', backupKeep: '7',
  botCount: '0', botActive: '1', botInterval: '30', botAggression: '3', botAttackPlayers: '1', botMark: '0',
};

// World rules an admin can change while the game runs. They are stored as `world.<key>` and laid over the world file,
// which keeps the original values so "reset to defaults" is possible. Only rules the game reads on every use are listed.
const WORLD_RULES = [
  { key: 'name', label: 'Name der Welt', type: 'text', max: 40 },
  { key: 'description', label: 'Beschreibung', type: 'textarea', max: 500 },
  { key: 'beginnerProtection', label: 'Anfängerschutz (Minuten)', type: 'number', min: 0, max: 100000, help: 'Gilt für neue Spieler; wird durch den Geschwindigkeits-Faktor verkürzt.' },
  { key: 'attackSelf', label: 'Eigene Dörfer angreifen', type: 'bool' },
  { key: 'destroyBuildings', label: 'Katapulte zerstören Gebäude', type: 'bool' },
  { key: 'morale', label: 'Moral', type: 'select', options: [['points', 'nach Punkten'], ['none', 'aus']] },
  { key: 'nightBonus', label: 'Nachtbonus (Verteidigung ×)', type: 'number', min: 1, max: 10, step: 0.1 },
  { key: 'nightStart', label: 'Nacht beginnt', type: 'time' },
  { key: 'nightEnd', label: 'Nacht endet', type: 'time' },
  { key: 'basicDefense', label: 'Grundverteidigung', type: 'number', min: 0, max: 1000 },
  { key: 'unitsSpeed', label: 'Truppengeschwindigkeit (×)', type: 'number', min: 0.1, max: 100, step: 0.1 },
  { key: 'noblemanMinDecrease', label: 'Adelsgeschlecht: Zustimmung min. −', type: 'number', min: 0, max: 100 },
  { key: 'noblemanMaxDecrease', label: 'Adelsgeschlecht: Zustimmung max. −', type: 'number', min: 0, max: 100 },
  { key: 'loyaltyIncrease', label: 'Zustimmung steigt pro Stunde', type: 'number', min: 0, max: 100, step: 0.1 },
  { key: 'tribeMemberLimit', label: 'Max. Stammesmitglieder', type: 'number', min: 1, max: 1000 },
  { key: 'knightActive', label: 'Paladin aktiv', type: 'bool' },
  { key: 'knightItemProgress', label: 'Paladin-Fortschritt pro Kampf (%)', type: 'number', min: 0, max: 100 },
];
const ORIGINAL = Object.fromEntries(WORLD_RULES.map((r) => [r.key, cfg.world[r.key]]));

function coerce(rule, raw) {
  if (rule.type === 'bool') return raw === true || raw === 'true' || raw === '1' || raw === 'on';
  if (rule.type === 'number') {
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) return null;
    return Math.min(rule.max ?? Infinity, Math.max(rule.min ?? -Infinity, n));
  }
  if (rule.type === 'time') return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(raw)) ? String(raw) : null;
  if (rule.type === 'select') return rule.options.some(([v]) => v === raw) ? raw : null;
  const text = String(raw ?? '').trim().slice(0, rule.max || 200);
  return rule.key === 'name' && !text ? null : text;
}

function load(db) {
  const rows = Object.fromEntries(db.prepare('SELECT key, value FROM setting').all().map((r) => [r.key, r.value]));
  return { ...DEFAULTS, ...rows };
}

function apply(db) {
  const s = load(db);
  const mult = Math.min(1000, Math.max(0.1, Number(s.speedMultiplier) || 1));
  for (const rule of WORLD_RULES) {
    const stored = s[`world.${rule.key}`];
    const value = stored === undefined ? undefined : coerce(rule, JSON.parse(stored));
    cfg.world[rule.key] = value === undefined || value === null ? ORIGINAL[rule.key] : value;
  }
  cfg.SPEED_MULT = mult;
  cfg.SPEED = (cfg.world.speed / 1000) * mult;
  cfg.PROTECTION_SECONDS = (cfg.world.beginnerProtection * 60) / mult;
  return s;
}

function set(db, key, value) {
  db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  return apply(db);
}

// Saves every rule from a submitted form; invalid entries keep the previous value. Returns the names that were rejected.
function setWorldRules(db, body) {
  const rejected = [];
  for (const rule of WORLD_RULES) {
    const raw = rule.type === 'bool' ? (body[rule.key] ? true : false) : body[rule.key];
    const value = coerce(rule, raw);
    if (value === null) { rejected.push(rule.label); continue; }
    const same = value === ORIGINAL[rule.key];
    if (same) db.prepare('DELETE FROM setting WHERE key = ?').run(`world.${rule.key}`);
    else db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`world.${rule.key}`, JSON.stringify(value));
  }
  apply(db);
  return rejected;
}

function resetWorldRules(db) {
  db.prepare("DELETE FROM setting WHERE key LIKE 'world.%'").run();
  apply(db);
}

const registrationOpen = (db) => load(db).registration !== 'closed';

module.exports = { load, apply, set, registrationOpen, WORLD_RULES, ORIGINAL, setWorldRules, resetWorldRules };
