'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

// Several worlds = several instances: copy config/worlds/world to config/worlds/<name> and start with TW_WORLD=<name>.
const worldDir = `config/worlds/${process.env.TW_WORLD || 'world'}`;
const worldCfg = readJson(`${worldDir}/world.json`);
const buildings = readJson(`${worldDir}/buildings.json`);
const units = readJson(`${worldDir}/units.json`);

// Local overrides (config/server.json or TW_SPEED_MULT) multiply the world's own speed; handy for testing.
let local = {};
try { local = readJson('config/server.json'); } catch { /* optional file */ }
const SPEED_MULT = Number(process.env.TW_SPEED_MULT || local.speedMultiplier || 1);

// world.json stores the game speed in thousandths (5000 = 5x).
const SPEED = (worldCfg.world.speed / 1000) * SPEED_MULT;

// New players are safe from attacks for a while; the real-time length shrinks with a speed multiplier.
const PROTECTION_SECONDS = (worldCfg.world.beginnerProtection * 60) / SPEED_MULT;

const languages = {};
function lang(code = 'en') {
  if (!languages[code]) languages[code] = readJson(`config/language/${code}.json`);
  return languages[code];
}

// Strings the original referenced but never shipped in its language files.
const FALLBACKS = {
  en: { 'game.overview.cancel_build': 'Really cancel this construction order?', 'game.menu.settings.sitter': 'Sitter', 'game.menu.settings.vacation': 'Urlaub' },
  de: { 'game.overview.cancel_build': 'Diesen Bauauftrag wirklich abbrechen?', 'game.menu.settings.sitter': 'Sitter', 'game.menu.settings.vacation': 'Urlaub' },
};

// The language files nest sections ("game.menu" -> {...}), so a dotted key is
// resolved by longest-prefix match on the top-level keys.
function translate(code, key, params = {}) {
  if (typeof key !== 'string') return '';
  const dict = lang(code);
  const parts = key.split('.');
  let value;
  for (let i = parts.length - 1; i >= 1; i--) {
    const section = dict[parts.slice(0, i).join('.')];
    if (section && parts.slice(i).join('.') in section) {
      value = section[parts.slice(i).join('.')];
      break;
    }
  }
  if (value === undefined) value = (FALLBACKS[code] || FALLBACKS.en)[key] ?? key;
  return String(value).replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
}

const languageNames = { ae: 'العربية', ar: 'Español (AR)', br: 'Português (BR)', cz: 'Čeština', de: 'Deutsch', dk: 'Dansk', en: 'English', es: 'Español', fi: 'Suomi', fr: 'Français', gr: 'Ελληνικά', hu: 'Magyar', it: 'Italiano', nl: 'Nederlands', no: 'Norsk', pl: 'Polski', pt: 'Português', ro: 'Română', ru: 'Русский', se: 'Svenska', sk: 'Slovenčina', sl: 'Slovenščina', tr: 'Türkçe' };
const languageCodes = fs.readdirSync(path.join(ROOT, 'config', 'language')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

module.exports = {
  ROOT,
  languageCodes,
  languageNames,
  LANG: process.env.TW_LANG || 'de',
  world: worldCfg.world,
  villageImages: worldCfg.village,
  buildings,
  units,
  SPEED,
  SPEED_MULT,
  PROTECTION_SECONDS,
  physicalRes: worldCfg.world.physicalRes.split(','),
  lang,
  translate,
};
