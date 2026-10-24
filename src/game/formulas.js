'use strict';
const cfg = require('../config');

const round = Math.round;
const grow = (c, level) => c.base * Math.pow(c.factor, level - 1);

// Churches only exist on worlds that enable them.
const BUILDING_IDS = Object.keys(cfg.buildings).filter((id) => cfg.world.church || !id.startsWith('church'));

function building(id) {
  const b = cfg.buildings[id];
  if (!b) throw new Error(`unknown building ${id}`);
  return b;
}

function buildCost(id, res, level) {
  return round(grow(building(id).buildCosts[res], level));
}

// Resource/population cost of going from level-1 to level, as shown to the player.
function buildPopulation(id, level) {
  const cost = (l) => (l < 1 ? 0 : buildCost(id, 'population', l));
  return cost(level) - cost(level - 1);
}

// Seconds to build `level`, shortened by the headquarters level and world speed.
function buildTime(id, level, mainLevel) {
  const t = grow(building(id).buildCosts.time, level);
  const mainFactor = Math.pow(cfg.world.buildMainFactor, -mainLevel);
  return Math.max(1, round((t * mainFactor) / cfg.SPEED));
}

function buildPoints(id, level) {
  if (level < 1) return 0;
  return round(grow(building(id).points, level));
}

// Production per hour of one resource building (level 0 yields the "zero" rate).
function production(id, res, level) {
  const p = building(id).res.prod[res];
  if (!p) return 0;
  if (level < 1) return Number(p.zero) * cfg.SPEED;
  return round(Number(p.base) * Math.pow(Number(p.factor), level - 1) * cfg.SPEED);
}

function capacity(id, res, level) {
  const m = building(id).res.max[res];
  if (!m || level < 1) return 0;
  return round(Number(m.base) * Math.pow(Number(m.factor), level - 1));
}

function hideCapacity(level) {
  const h = building('hide').res.max.wood;
  return level < 1 ? 0 : round(Number(h.base) * Math.pow(Number(h.factor), level - 1));
}

module.exports = {
  BUILDING_IDS, buildCost, buildPopulation, buildTime, buildPoints,
  production, capacity, hideCapacity,
};
