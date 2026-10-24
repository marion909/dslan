'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const cfg = require('./config');

// The active player's language travels with the request, so t() needs no extra argument.
const langStore = new AsyncLocalStorage();
const currentLang = () => langStore.getStore()?.lang || cfg.LANG;
const t = (key, params) => cfg.translate(currentLang(), key, params);

function pad(n) { return String(n).padStart(2, '0'); }

// h:mm:ss, as used for build times and timers.
function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

function clock(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const fileExists = (rel) => fs.existsSync(path.join(cfg.ROOT, 'public', rel));

// Picks the building picture for a level from the thresholds in buildings.json.
function buildingImage(id, level, dir = 'buildings/mid') {
  const steps = Object.entries(cfg.buildings[id].img.level).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]);
  let pick = steps[0][1];
  for (const [from, name] of steps) if (level >= from) pick = name;
  const file = `${id}${pick}.png`;
  return fileExists(`graphic/${dir}/${file}`) ? file : `${id}1.png`;
}

// Picture files in graphic/visual: levels are png, empty plots and some old ones gif.
function visualFile(dir, base) {
  for (const ext of ['png', 'gif']) if (fileExists(`graphic/${dir}/${base}.${ext}`)) return `${dir}/${base}.${ext}`;
  return null;
}

const stepFor = (levels, level) => {
  let pick = null;
  for (const [from, name] of Object.entries(levels).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0])) {
    if (level >= from) pick = name;
  }
  return pick;
};

function isNight(date = new Date()) {
  const [sh, sm] = cfg.world.nightStart.split(':').map(Number);
  const [eh, em] = cfg.world.nightEnd.split(':').map(Number);
  const m = date.getHours() * 60 + date.getMinutes();
  const start = sh * 60 + sm; const end = eh * 60 + em;
  return start > end ? m >= start || m < end : m >= start && m < end;
}

// Layers of the graphical village: [cssClass, imagePath] per building.
function buildingVisual(id, level, { queued = false, active = false, night = false } = {}) {
  const dir = night ? 'visual_night' : 'visual';
  const img = cfg.buildings[id].img;
  const out = [];
  const pick = stepFor(img.level, level);
  if (level > 0 && pick) {
    const file = visualFile(dir, `${id}${pick}`) || visualFile('visual', `${id}${pick}`);
    if (file) out.push([`p_${id}`, file]);
  } else if (queued) {
    const file = visualFile(dir, `${id}0`) || visualFile('visual', `${id}0`);
    if (file) out.push([`cons_${id}`, file]);
  }
  if (level > 0) {
    for (const [cls, steps] of Object.entries(img.misc || {})) {
      const name = stepFor(steps, level);
      if (name) out.push([cls, `${dir}/${name}`]);
    }
    for (const [cls, file] of Object.entries(img.active || {})) {
      if (active || cls.startsWith('npc_')) out.push([cls, `${dir}/${file}`]);
    }
  }
  return out;
}

const buildingName = (id) => t(`building${id.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join('')}.name`);

const number = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const dateText = (epoch) => {
  const d = new Date(epoch * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// What every EJS template (full page or partial) can call.
const unitName = (id, n) => t(`unit${id[0].toUpperCase()}${id.slice(1)}.${n === 1 ? 'name' : 'plural'}`);
// Premium points: one per started ten minutes of remaining time.
const ppCost = (seconds) => Math.max(1, Math.ceil(seconds / 600));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const helpers = { ppCost, t, duration, clock, buildingImage, buildingName, number, dateText, unitName, esc };

module.exports = { esc, ppCost, unitName, helpers, dateText, langStore, currentLang, isNight, buildingVisual, t, duration, clock, buildingImage, buildingName, number, cfg };
