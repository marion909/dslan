'use strict';
const { transaction } = require('../db');
const settings = require('../settings');
const players = require('./players');

// Every column that holds a point in time of the running game. While the world is paused nothing moves, so on
// resume all of them are pushed back by the length of the pause: queues, marches, production and protection resume where they stopped.
const SHIFT = [
  ['village', 'res_updated_at'], ['village', 'loyalty_at'], ['build_queue', 'start_at'], ['build_queue', 'finish_at'],
  ['train_queue', 'start_at'], ['train_queue', 'finish_at'], ['research_queue', 'start_at'], ['research_queue', 'finish_at'],
  ['command', 'depart_at'], ['command', 'arrive_at'], ['user', 'created_at'], ['user', 'last_seen'], ['user', 'vacation_until'],
  ['bot', 'next_at'], ['knight', 'revive_at'], ['reservation', 'time'], ['market_offer', 'created_at'],
];

const isPaused = () => settings.cfgPaused();

function start(db) {
  if (isPaused()) return false;
  settings.set(db, 'paused', '1');
  settings.set(db, 'pausedAt', String(Date.now() / 1000));
  players.log(db, 'Welt pausiert');
  return true;
}

function resume(db) {
  if (!isPaused()) return false;
  const since = Number(settings.load(db).pausedAt) || Date.now() / 1000;
  const delta = Date.now() / 1000 - since;
  transaction(db, () => {
    for (const [table, column] of SHIFT) db.prepare(`UPDATE ${table} SET ${column} = ${column} + ? WHERE ${column} > 0`).run(delta);
    settings.set(db, 'paused', '0');
  });
  players.log(db, `Welt fortgesetzt (Pause: ${Math.round(delta / 60)} Minuten)`);
  return true;
}

module.exports = { start, resume, isPaused, SHIFT };
