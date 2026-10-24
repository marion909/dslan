'use strict';
const v = require('./village');
const u = require('./units');
const { ppCost } = require('../view');
const { transaction } = require('../db');

const now = () => Date.now() / 1000;

const balance = (db, userId) => (db.prepare('SELECT pp FROM user WHERE id = ?').get(userId) || { pp: 0 }).pp;

function grant(db, userId, delta, reason) {
  return transaction(db, () => {
    const user = db.prepare('SELECT pp FROM user WHERE id = ?').get(userId);
    if (!user) return { ok: false, error: 'noUser' };
    if (user.pp + delta < 0) return { ok: false, error: 'noPoints' };
    db.prepare('UPDATE user SET pp = pp + ? WHERE id = ?').run(delta, userId);
    db.prepare('INSERT INTO pp_log (user_id, time, delta, reason) VALUES (?,?,?,?)').run(userId, Math.floor(now()), delta, reason);
    return { ok: true };
  });
}

// Moves every order of a queue forward so that its running order ends right now. The extra
// hundredth of a second keeps floating-point rounding (timestamps are ~1.8e9) from leaving a unit behind.
const pull = (db, table, where, args, remaining) => db.prepare(`UPDATE ${table} SET start_at = start_at - ?, finish_at = finish_at - ? WHERE ${where}`).run(remaining + 0.01, remaining + 0.01, ...args);

function finish(db, userId, villageId, kind, building) {
  return transaction(db, () => {
    const village = v.processQueue(db, villageId);
    if (!village || village.user_id !== userId) return { ok: false, error: 'noSource' };
    u.processTraining(db, villageId); u.processResearch(db, villageId);
    let first;
    if (kind === 'build') first = v.getQueue(db, villageId)[0];
    else if (kind === 'train') first = u.getTrainQueue(db, villageId, building)[0];
    else first = u.getResearchQueue(db, villageId)[0];
    if (!first) return { ok: false, error: 'nothing' };
    const remaining = first.finish_at - now();
    if (remaining <= 0) return { ok: false, error: 'nothing' };
    const cost = ppCost(remaining);
    const paid = grant(db, userId, -cost, kind === 'build' ? 'Bauauftrag sofort fertiggestellt' : kind === 'train' ? 'Rekrutierung sofort fertiggestellt' : 'Forschung sofort fertiggestellt');
    if (!paid.ok) return { ok: false, error: 'noPoints', cost };
    if (kind === 'build') pull(db, 'build_queue', 'village_id = ?', [villageId], remaining);
    else if (kind === 'train') pull(db, 'train_queue', 'village_id = ? AND building = ?', [villageId, building], remaining);
    else pull(db, 'research_queue', 'village_id = ?', [villageId], remaining);
    v.processQueue(db, villageId); u.processTraining(db, villageId); u.processResearch(db, villageId);
    return { ok: true, cost };
  });
}

// Which queue a screen belongs to.
function finishFor(db, userId, villageId, screen) {
  if (screen === 'main') return finish(db, userId, villageId, 'build');
  if (screen === 'smith') return finish(db, userId, villageId, 'research');
  if (['barracks', 'stable', 'garage', 'snob', 'statue'].includes(screen)) return finish(db, userId, villageId, 'train', screen);
  return { ok: false, error: 'nothing' };
}

module.exports = { balance, grant, finish, finishFor };
