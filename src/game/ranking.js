'use strict';
const v = require('./village');

// Village points need every building level, so results are cached for a few seconds.
let cache = { at: 0, db: null, value: null };
const TTL = 3000;

const continentOf = (x, y) => `${Math.floor(y / 100)}${Math.floor(x / 100)}`;

function snapshot(db) {
  if (cache.db === db && Date.now() - cache.at < TTL) return cache.value;
  const users = db.prepare('SELECT u.id, u.name, u.ally_id, a.tag AS tag, a.name AS ally_name, u.kills_att, u.kills_def FROM user u LEFT JOIN ally a ON a.id = u.ally_id WHERE u.banned = 0').all();
  const byUser = new Map(users.map((u) => [u.id, { ...u, points: 0, villages: 0, continents: {} }]));
  for (const r of db.prepare('SELECT id, user_id, x, y FROM village WHERE user_id IS NOT NULL').all()) {
    const u = byUser.get(r.user_id);
    if (!u) continue;
    const pts = v.villagePoints(v.getBuildings(db, r.id));
    u.points += pts; u.villages += 1;
    const c = continentOf(r.x, r.y);
    u.continents[c] = (u.continents[c] || 0) + pts;
  }
  const value = { players: [...byUser.values()] };
  cache = { at: Date.now(), db, value };
  return value;
}

const rank = (rows, key) => [...rows].sort((a, b) => b[key] - a[key] || a.id - b.id).map((r, i) => ({ ...r, rank: i + 1 }));

function players(db) { return rank(snapshot(db).players, 'points'); }

function allies(db) {
  const map = new Map();
  for (const p of snapshot(db).players) {
    if (!p.ally_id) continue;
    const a = map.get(p.ally_id) || { id: p.ally_id, name: p.ally_name, tag: p.tag, points: 0, villages: 0, members: 0, kills: 0 };
    a.points += p.points; a.villages += p.villages; a.members += 1; a.kills += p.kills_att + p.kills_def;
    map.set(p.ally_id, a);
  }
  return rank([...map.values()], 'points');
}

function playersKills(db, kind) {
  const key = kind === 'att' ? 'kills_att' : kind === 'def' ? 'kills_def' : 'kills';
  return rank(snapshot(db).players.map((p) => ({ ...p, kills: p.kills_att + p.kills_def })), key);
}

function alliesKills(db) { return rank(allies(db), 'kills'); }

function playersContinent(db, con) {
  return rank(snapshot(db).players.map((p) => ({ ...p, points: p.continents[con] || 0 })).filter((p) => p.points > 0), 'points');
}

function alliesContinent(db, con) {
  const map = new Map();
  for (const p of snapshot(db).players) {
    const pts = p.continents[con] || 0;
    if (!p.ally_id || !pts) continue;
    const a = map.get(p.ally_id) || { id: p.ally_id, name: p.ally_name, tag: p.tag, points: 0, members: 0, villages: 0 };
    a.points += pts; a.members += 1;
    map.set(p.ally_id, a);
  }
  return rank([...map.values()], 'points');
}

// Running wars with the kill points of both sides, biggest fights first.
function wars(db) {
  const rows = db.prepare(`SELECT c.ally_id AS a, c.other_id AS b, x.name AS a_name, x.tag AS a_tag, y.name AS b_name, y.tag AS b_tag,
      COALESCE((SELECT kills FROM war_stat s WHERE s.ally_id = c.ally_id AND s.other_id = c.other_id), 0) AS a_kills,
      COALESCE((SELECT kills FROM war_stat s WHERE s.ally_id = c.other_id AND s.other_id = c.ally_id), 0) AS b_kills
    FROM ally_contract c JOIN ally x ON x.id = c.ally_id JOIN ally y ON y.id = c.other_id WHERE c.type = 'enemy' AND c.ally_id < c.other_id`).all();
  return rows.map((r) => ({ ...r, total: r.a_kills + r.b_kills })).sort((p, q) => q.total - p.total).map((r, i) => ({ ...r, rank: i + 1 }));
}

const playerRank = (db, userId) => players(db).find((p) => p.id === userId) || { rank: 0, points: 0 };
const invalidate = () => { cache = { at: 0, db: null, value: null }; };

module.exports = { wars, players, allies, playersKills, alliesKills, playersContinent, alliesContinent, playerRank, continentOf, invalidate };
