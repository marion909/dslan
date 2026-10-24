'use strict';
const cfg = require('../config');

// Which of a defender's three defence values applies against each attacking unit type.
const DEF_AGAINST = { general: 'general', cavalry: 'cavalry', archer: 'archer' };

const unitCfg = (u) => cfg.units[u];

// Wall: +3.7% defence per level, plus the world's flat base defence.
const wallMultiplier = (level) => Math.pow(1.037, level);

// `boost` maps a unit to { att, def } multipliers (knight items); missing means 1.
function attackStrength(army, boost = {}) {
  const byType = { general: 0, cavalry: 0, archer: 0 };
  for (const [u, n] of Object.entries(army)) {
    const c = unitCfg(u);
    if (n > 0 && byType[c.type] !== undefined) byType[c.type] += n * c.atk.base * ((boost[u] && boost[u].att) || 1);
  }
  return byType;
}

function defenseAgainst(army, type, boost = {}) {
  let sum = 0;
  for (const [u, n] of Object.entries(army)) {
    if (n > 0) sum += n * (unitCfg(u).def[DEF_AGAINST[type]]?.base || 0) * ((boost[u] && boost[u].def) || 1);
  }
  return sum;
}

// Attacking a village that is much smaller than you is penalised; never below 30%.
function morale(attackerPoints, defenderPoints) {
  if (cfg.world.morale !== 'points' || attackerPoints <= defenderPoints || attackerPoints <= 0) return 1;
  return Math.min(1, Math.max(0.3, 0.3 + 0.7 * (defenderPoints / attackerPoints)));
}

// Rounded, so a lone unit is not wiped out by a tiny loss share.
const scale = (army, ratio) => Object.fromEntries(Object.entries(army).map(([u, n]) => [u, Math.min(n, Math.round(n * ratio))]));
const lossesOf = (before, after) => Object.fromEntries(Object.entries(before).map(([u, n]) => [u, n - (after[u] || 0)]));

/**
 * Resolves one battle. `attacker`/`defender` are { unit: count }.
 * `luck` is a number in [-0.25, 0.25]; passed in so tests stay deterministic.
 */
function resolve({ attacker, defender, wallLevel = 0, attackerPoints = 0, defenderPoints = 0, luck = 0, defenseBonus = 1, attackBonus = 1, attackerBoost = {}, defenderBoost = {} }) {
  const strength = attackStrength(attacker, attackerBoost);
  const total = strength.general + strength.cavalry + strength.archer;
  const mor = morale(attackerPoints, defenderPoints);
  const attack = total * (1 + luck) * mor * attackBonus;

  const wall = wallMultiplier(wallLevel);
  let defense = 0;
  if (total > 0) {
    for (const type of Object.keys(strength)) {
      const share = strength[type] / total;
      if (share > 0) defense += share * (defenseAgainst(defender, type, defenderBoost) + cfg.world.basicDefense) * wall;
    }
  } else {
    defense = (defenseAgainst(defender, 'general', defenderBoost) + cfg.world.basicDefense) * wall;
  }

  defense *= defenseBonus;

  let attackerRatio; let defenderRatio; let win;
  if (attack > defense) {
    win = true;
    attackerRatio = defense > 0 ? Math.pow(defense / attack, 1.5) : 0;
    defenderRatio = 1;
  } else {
    win = false;
    attackerRatio = 1;
    defenderRatio = attack > 0 ? Math.pow(attack / defense, 1.5) : 0;
  }
  attackerRatio = Math.min(1, attackerRatio);
  defenderRatio = Math.min(1, defenderRatio);

  const attackerSurvivors = scale(attacker, 1 - attackerRatio);
  const defenderSurvivors = scale(defender, 1 - defenderRatio);
  return {
    win, luck, morale: mor, attack, defense, attackerLossRatio: attackerRatio, defenderLossRatio: defenderRatio,
    attackerSurvivors, defenderSurvivors,
    attackerLosses: lossesOf(attacker, attackerSurvivors),
    defenderLosses: lossesOf(defender, defenderSurvivors),
  };
}

// Surviving rams knock levels off the wall; more rams are needed the higher it is.
function wallAfter(wallLevel, survivingRams) {
  if (survivingRams <= 0 || wallLevel <= 0) return wallLevel;
  return Math.max(0, wallLevel - Math.floor(survivingRams / (2 + wallLevel * 0.5)));
}

function buildingAfter(level, survivingCatapults) {
  if (survivingCatapults <= 0 || level <= 0) return level;
  return Math.max(0, level - Math.floor(survivingCatapults / (4 + level * 0.8)));
}

// Takes loot evenly from what is not hidden, up to what the survivors can carry.
function loot(survivors, resources, hidden) {
  let capacity = 0;
  for (const [u, n] of Object.entries(survivors)) capacity += n * unitCfg(u).haul.base;
  const available = Object.fromEntries(cfg.physicalRes.map((r) => [r, Math.max(0, Math.floor(resources[r] - hidden))]));
  const result = Object.fromEntries(cfg.physicalRes.map((r) => [r, 0]));
  let remaining = Math.floor(capacity);
  let open = cfg.physicalRes.filter((r) => available[r] > 0);
  while (remaining > 0 && open.length) {
    const share = Math.max(1, Math.floor(remaining / open.length));
    for (const r of open) {
      const take = Math.min(share, available[r] - result[r], remaining);
      result[r] += take; remaining -= take;
    }
    open = open.filter((r) => result[r] < available[r]);
  }
  return { loot: result, capacity: Math.floor(capacity) };
}

module.exports = { resolve, wallAfter, buildingAfter, loot, morale, wallMultiplier, attackStrength, defenseAgainst };
