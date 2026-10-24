'use strict';
const cfg = require('../config');
const { transaction } = require('../db');
const ranking = require('./ranking');

const RIGHTS = {
  invite: 'Spieler einladen', members: 'Mitglieder verwalten', diplomacy: 'Diplomatie', forum: 'Forum moderieren',
  profile: 'Stammesprofil bearbeiten', mail: 'Rundschreiben',
};
const NAME_RE = /^[\p{L}\p{N} _\-.]{3,32}$/u;
const TAG_RE = /^[\p{L}\p{N}_\-.\[\]]{2,6}$/u;
const now = () => Math.floor(Date.now() / 1000);

const rightsOf = (user) => { try { return JSON.parse(user.ally_rights || '[]'); } catch { return []; } };

function isLeader(db, user) {
  return !!user.ally_id && !!db.prepare('SELECT 1 FROM ally WHERE id = ? AND leader_id = ?').get(user.ally_id, user.id);
}

// The leader may do everything; everyone else needs the right granted.
function can(db, user, right) {
  if (!user.ally_id) return false;
  return isLeader(db, user) || rightsOf(user).includes(right);
}

function log(db, allyId, text) {
  db.prepare('INSERT INTO ally_event (ally_id, time, text) VALUES (?,?,?)').run(allyId, now(), text);
}

const members = (db, allyId) => db.prepare('SELECT id, name, ally_title, ally_rights FROM user WHERE ally_id = ? ORDER BY name').all(allyId);

function found(db, user, name, tag) {
  return transaction(db, () => {
    if (user.ally_id) return { ok: false, error: 'alreadyMember' };
    name = String(name || '').trim(); tag = String(tag || '').trim();
    if (!NAME_RE.test(name)) return { ok: false, error: 'badName' };
    if (!TAG_RE.test(tag)) return { ok: false, error: 'badTag' };
    if (db.prepare('SELECT 1 FROM ally WHERE name = ? OR tag = ?').get(name, tag)) return { ok: false, error: 'taken' };
    const info = db.prepare('INSERT INTO ally (name, tag, leader_id, created_at) VALUES (?,?,?,?)').run(name, tag, user.id, now());
    const id = Number(info.lastInsertRowid);
    db.prepare("UPDATE user SET ally_id = ?, ally_title = 'Gründer' WHERE id = ?").run(id, user.id);
    log(db, id, `${user.name} hat den Stamm gegründet.`);
    return { ok: true, id };
  });
}

function invite(db, user, targetName) {
  return transaction(db, () => {
    if (!can(db, user, 'invite')) return { ok: false, error: 'denied' };
    const target = db.prepare('SELECT * FROM user WHERE name = ?').get(String(targetName || '').trim());
    if (!target) return { ok: false, error: 'noUser' };
    if (target.ally_id) return { ok: false, error: 'alreadyMember' };
    db.prepare('INSERT OR REPLACE INTO ally_invite (ally_id, user_id, time) VALUES (?,?,?)').run(user.ally_id, target.id, now());
    db.prepare('INSERT INTO message (from_id, to_id, subject, body, time) VALUES (?,?,?,?,?)').run(user.id, target.id, 'Stammeseinladung', 'Du wurdest in einen Stamm eingeladen. Die Einladung findest du im Bereich „Stamm“.', now());
    return { ok: true };
  });
}

// Players without a tribe may apply (a few at a time); members with the invite right decide.
function apply(db, user, allyId, text) {
  return transaction(db, () => {
    if (user.ally_id) return { ok: false, error: 'alreadyMember' };
    const ally = db.prepare('SELECT id FROM ally WHERE id = ?').get(allyId);
    if (!ally) return { ok: false, error: 'noAlly' };
    if (db.prepare('SELECT COUNT(*) AS n FROM ally_application WHERE user_id = ?').get(user.id).n >= 3) return { ok: false, error: 'tooManyApplications' };
    db.prepare('INSERT OR REPLACE INTO ally_application (ally_id, user_id, text, time) VALUES (?,?,?,?)').run(allyId, user.id, String(text || '').slice(0, 500), now());
    return { ok: true };
  });
}

const applicationsOf = (db, allyId) => db.prepare('SELECT a.user_id, a.text, a.time, u.name FROM ally_application a JOIN user u ON u.id = a.user_id WHERE a.ally_id = ? ORDER BY a.time').all(allyId);

function answerApplication(db, user, applicantId, accept_) {
  return transaction(db, () => {
    if (!can(db, user, 'invite')) return { ok: false, error: 'denied' };
    const app = db.prepare('SELECT * FROM ally_application WHERE ally_id = ? AND user_id = ?').get(user.ally_id, applicantId);
    if (!app) return { ok: false, error: 'noApplication' };
    const applicant = db.prepare('SELECT * FROM user WHERE id = ?').get(applicantId);
    db.prepare('DELETE FROM ally_application WHERE ally_id = ? AND user_id = ?').run(user.ally_id, applicantId);
    const ally = db.prepare('SELECT name FROM ally WHERE id = ?').get(user.ally_id);
    if (accept_ && applicant && !applicant.ally_id) {
      if (db.prepare('SELECT COUNT(*) AS n FROM user WHERE ally_id = ?').get(user.ally_id).n >= cfg.world.tribeMemberLimit) return { ok: false, error: 'full' };
      db.prepare("UPDATE user SET ally_id = ?, ally_title = '', ally_rights = '[]' WHERE id = ?").run(user.ally_id, applicantId);
      db.prepare('DELETE FROM ally_application WHERE user_id = ?').run(applicantId);
      log(db, user.ally_id, `${applicant.name} wurde aufgenommen.`);
    }
    db.prepare('INSERT INTO message (from_id, to_id, subject, body, time) VALUES (?,?,?,?,?)').run(user.id, applicantId, 'Bewerbung', accept_ ? `Deine Bewerbung bei ${ally.name} wurde angenommen.` : `Deine Bewerbung bei ${ally.name} wurde abgelehnt.`, now());
    return { ok: true };
  });
}

function accept(db, user, allyId) {
  return transaction(db, () => {
    if (user.ally_id) return { ok: false, error: 'alreadyMember' };
    const inv = db.prepare('SELECT 1 FROM ally_invite WHERE ally_id = ? AND user_id = ?').get(allyId, user.id);
    if (!inv) return { ok: false, error: 'noInvite' };
    const count = db.prepare('SELECT COUNT(*) AS n FROM user WHERE ally_id = ?').get(allyId).n;
    if (count >= cfg.world.tribeMemberLimit) return { ok: false, error: 'full' };
    db.prepare("UPDATE user SET ally_id = ?, ally_title = '', ally_rights = '[]' WHERE id = ?").run(allyId, user.id);
    db.prepare('DELETE FROM ally_invite WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM ally_application WHERE user_id = ?').run(user.id);
    log(db, allyId, `${user.name} ist dem Stamm beigetreten.`);
    return { ok: true };
  });
}

function leave(db, user) {
  return transaction(db, () => {
    if (!user.ally_id) return { ok: false, error: 'noAlly' };
    if (isLeader(db, user)) return { ok: false, error: 'leader' };
    db.prepare("UPDATE user SET ally_id = NULL, ally_title = '', ally_rights = '[]' WHERE id = ?").run(user.id);
    db.prepare('DELETE FROM reservation WHERE user_id = ?').run(user.id);
    log(db, user.ally_id, `${user.name} hat den Stamm verlassen.`);
    return { ok: true };
  });
}

function kick(db, user, targetId) {
  return transaction(db, () => {
    if (!can(db, user, 'members')) return { ok: false, error: 'denied' };
    const target = db.prepare('SELECT * FROM user WHERE id = ? AND ally_id = ?').get(targetId, user.ally_id);
    if (!target || target.id === user.id) return { ok: false, error: 'noUser' };
    if (isLeader(db, target)) return { ok: false, error: 'leader' };
    db.prepare("UPDATE user SET ally_id = NULL, ally_title = '', ally_rights = '[]' WHERE id = ?").run(target.id);
    db.prepare('DELETE FROM reservation WHERE user_id = ?').run(target.id);
    log(db, user.ally_id, `${target.name} wurde von ${user.name} ausgeschlossen.`);
    return { ok: true };
  });
}

function setMember(db, user, targetId, { title, rights }) {
  return transaction(db, () => {
    if (!can(db, user, 'members')) return { ok: false, error: 'denied' };
    const target = db.prepare('SELECT * FROM user WHERE id = ? AND ally_id = ?').get(targetId, user.ally_id);
    if (!target) return { ok: false, error: 'noUser' };
    const list = (rights || []).filter((r) => RIGHTS[r]);
    db.prepare('UPDATE user SET ally_title = ?, ally_rights = ? WHERE id = ?').run(String(title || '').slice(0, 32), JSON.stringify(list), target.id);
    return { ok: true };
  });
}

function transferLead(db, user, targetId) {
  return transaction(db, () => {
    if (!isLeader(db, user)) return { ok: false, error: 'denied' };
    const target = db.prepare('SELECT * FROM user WHERE id = ? AND ally_id = ?').get(targetId, user.ally_id);
    if (!target || target.id === user.id) return { ok: false, error: 'noUser' };
    db.prepare('UPDATE ally SET leader_id = ? WHERE id = ?').run(target.id, user.ally_id);
    db.prepare("UPDATE user SET ally_title = 'Stammesführer' WHERE id = ?").run(target.id);
    db.prepare("UPDATE user SET ally_title = '' WHERE id = ?").run(user.id);
    log(db, user.ally_id, `${user.name} hat die Führung an ${target.name} übergeben.`);
    return { ok: true };
  });
}

function disband(db, user) {
  return transaction(db, () => {
    if (!isLeader(db, user)) return { ok: false, error: 'denied' };
    db.prepare("UPDATE user SET ally_id = NULL, ally_title = '', ally_rights = '[]' WHERE ally_id = ?").run(user.ally_id);
    db.prepare('DELETE FROM ally WHERE id = ?').run(user.ally_id);
    return { ok: true };
  });
}

function rename(db, user, name, tag) {
  return transaction(db, () => {
    if (!isLeader(db, user)) return { ok: false, error: 'denied' };
    name = String(name || '').trim(); tag = String(tag || '').trim();
    if (!NAME_RE.test(name)) return { ok: false, error: 'badName' };
    if (!TAG_RE.test(tag)) return { ok: false, error: 'badTag' };
    if (db.prepare('SELECT 1 FROM ally WHERE (name = ? OR tag = ?) AND id != ?').get(name, tag, user.ally_id)) return { ok: false, error: 'taken' };
    db.prepare('UPDATE ally SET name = ?, tag = ? WHERE id = ?').run(name, tag, user.ally_id);
    return { ok: true };
  });
}

// ---- diplomacy ----
const ACTIVE = ['partner', 'nap', 'enemy'];

function contracts(db, allyId) {
  return db.prepare('SELECT c.*, a.name AS other_name, a.tag AS other_tag FROM ally_contract c JOIN ally a ON a.id = c.other_id WHERE c.ally_id = ? ORDER BY c.time DESC').all(allyId);
}

function incomingProposals(db, allyId) {
  return db.prepare("SELECT c.*, a.name AS from_name, a.tag AS from_tag FROM ally_contract c JOIN ally a ON a.id = c.ally_id WHERE c.other_id = ? AND c.type LIKE 'prop_%'").all(allyId);
}

function propose(db, user, otherId, type) {
  return transaction(db, () => {
    if (!can(db, user, 'diplomacy')) return { ok: false, error: 'denied' };
    if (!ACTIVE.includes(type)) return { ok: false, error: 'badType' };
    const other = db.prepare('SELECT * FROM ally WHERE id = ?').get(otherId);
    if (!other || other.id === user.ally_id) return { ok: false, error: 'noAlly' };
    const t = now();
    const put = (a, b, ty) => db.prepare('INSERT INTO ally_contract (ally_id, other_id, type, time) VALUES (?,?,?,?) ON CONFLICT(ally_id, other_id) DO UPDATE SET type = excluded.type, time = excluded.time').run(a, b, ty, t);
    db.prepare('DELETE FROM ally_contract WHERE (ally_id = ? AND other_id = ?) OR (ally_id = ? AND other_id = ?)').run(user.ally_id, other.id, other.id, user.ally_id);
    if (type === 'enemy') { // a declaration of war needs no consent
      put(user.ally_id, other.id, 'enemy'); put(other.id, user.ally_id, 'enemy');
      db.prepare('DELETE FROM war_stat WHERE (ally_id = ? AND other_id = ?) OR (ally_id = ? AND other_id = ?)').run(user.ally_id, other.id, other.id, user.ally_id); // every war starts at zero
      log(db, user.ally_id, `Kriegserklärung an ${other.name}.`); log(db, other.id, `${(db.prepare('SELECT name FROM ally WHERE id = ?').get(user.ally_id) || {}).name} hat euch den Krieg erklärt.`);
    } else {
      put(user.ally_id, other.id, `prop_${type}`);
      log(db, user.ally_id, `Vorschlag (${type === 'partner' ? 'Bündnis' : 'Nichtangriffspakt'}) an ${other.name}.`);
    }
    return { ok: true };
  });
}

function answerProposal(db, user, fromId, accept_) {
  return transaction(db, () => {
    if (!can(db, user, 'diplomacy')) return { ok: false, error: 'denied' };
    const prop = db.prepare("SELECT * FROM ally_contract WHERE ally_id = ? AND other_id = ? AND type LIKE 'prop_%'").get(fromId, user.ally_id);
    if (!prop) return { ok: false, error: 'noProposal' };
    db.prepare('DELETE FROM ally_contract WHERE ally_id = ? AND other_id = ?').run(fromId, user.ally_id);
    if (accept_) {
      const type = prop.type.slice(5);
      const put = (a, b) => db.prepare('INSERT INTO ally_contract (ally_id, other_id, type, time) VALUES (?,?,?,?) ON CONFLICT(ally_id, other_id) DO UPDATE SET type = excluded.type, time = excluded.time').run(a, b, type, now());
      put(fromId, user.ally_id); put(user.ally_id, fromId);
      log(db, user.ally_id, `Vertrag (${type}) geschlossen.`); log(db, fromId, `Vertrag (${type}) geschlossen.`);
    }
    return { ok: true };
  });
}

function cancelContract(db, user, otherId) {
  return transaction(db, () => {
    if (!can(db, user, 'diplomacy')) return { ok: false, error: 'denied' };
    db.prepare('DELETE FROM ally_contract WHERE (ally_id = ? AND other_id = ?) OR (ally_id = ? AND other_id = ?)').run(user.ally_id, otherId, otherId, user.ally_id);
    log(db, user.ally_id, 'Ein Vertrag wurde beendet.');
    return { ok: true };
  });
}

// Relation of ally A to ally B for map colours: partner | nap | enemy | null.
function relation(db, a, b) {
  if (!a || !b || a === b) return null;
  const row = db.prepare('SELECT type FROM ally_contract WHERE ally_id = ? AND other_id = ?').get(a, b);
  return row && ACTIVE.includes(row.type) ? row.type : null;
}

// ---- forum ----
function threads(db, allyId, userId, board = null) {
  return db.prepare(`SELECT t.*, u.name AS author,
      (SELECT COUNT(*) FROM forum_post p WHERE p.thread_id = t.id) AS posts,
      (SELECT time FROM forum_read r WHERE r.thread_id = t.id AND r.user_id = ?) AS read_at
    FROM forum_thread t JOIN user u ON u.id = t.user_id WHERE t.ally_id = ? AND t.board_id IS ? ORDER BY t.updated_at DESC, t.id DESC LIMIT 100`).all(userId, allyId, board);
}

function newThread(db, user, title, body, { board = null, poll = '', options = [] } = {}) {
  return transaction(db, () => {
    if (!user.ally_id) return { ok: false, error: 'noAlly' };
    title = String(title || '').trim().slice(0, 120); body = String(body || '').trim().slice(0, 20000);
    if (!title || !body) return { ok: false, error: 'empty' };
    const t = now();
    if (board && !db.prepare('SELECT 1 FROM forum_board WHERE id = ? AND ally_id = ?').get(board, user.ally_id)) return { ok: false, error: 'noBoard' };
    const choices = [...new Set((options || []).map((o) => String(o).trim().slice(0, 80)).filter(Boolean))].slice(0, 10);
    if (String(poll || '').trim() && choices.length < 2) return { ok: false, error: 'pollOptions' };
    const info = db.prepare('INSERT INTO forum_thread (ally_id, user_id, title, created_at, updated_at, board_id) VALUES (?,?,?,?,?,?)').run(user.ally_id, user.id, title, t, t, board || null);
    const id = Number(info.lastInsertRowid);
    if (String(poll || '').trim()) {
      db.prepare('UPDATE forum_thread SET poll = ? WHERE id = ?').run(String(poll).trim().slice(0, 150), id);
      for (const c of choices) db.prepare('INSERT INTO forum_poll_option (thread_id, text) VALUES (?,?)').run(id, c);
    }
    db.prepare('INSERT INTO forum_post (thread_id, user_id, body, time) VALUES (?,?,?,?)').run(id, user.id, body, t);
    return { ok: true, id };
  });
}

function pollOf(db, thread, userId) {
  if (!thread.poll) return null;
  const options = db.prepare('SELECT o.id, o.text, (SELECT COUNT(*) FROM forum_poll_vote v WHERE v.option_id = o.id) AS votes FROM forum_poll_option o WHERE o.thread_id = ? ORDER BY o.id').all(thread.id);
  const mine = db.prepare('SELECT option_id FROM forum_poll_vote WHERE thread_id = ? AND user_id = ?').get(thread.id, userId);
  return { question: thread.poll, options, total: options.reduce((n, o) => n + o.votes, 0), mine: mine ? mine.option_id : null };
}

function vote(db, user, threadId, optionId) {
  return transaction(db, () => {
    const th = db.prepare('SELECT * FROM forum_thread WHERE id = ? AND ally_id = ?').get(threadId, user.ally_id);
    if (!th || !th.poll) return { ok: false, error: 'noThread' };
    if (th.closed) return { ok: false, error: 'closed' };
    if (!db.prepare('SELECT 1 FROM forum_poll_option WHERE id = ? AND thread_id = ?').get(optionId, th.id)) return { ok: false, error: 'noOption' };
    db.prepare('INSERT OR REPLACE INTO forum_poll_vote (thread_id, user_id, option_id) VALUES (?,?,?)').run(th.id, user.id, optionId);
    return { ok: true };
  });
}

function addBoard(db, user, name) {
  if (!user.ally_id || !can(db, user, 'forum')) return { ok: false, error: 'denied' };
  name = String(name || '').trim().slice(0, 40);
  if (!name) return { ok: false, error: 'empty' };
  db.prepare('INSERT INTO forum_board (ally_id, name) VALUES (?,?)').run(user.ally_id, name);
  return { ok: true };
}

function deleteBoard(db, user, boardId) {
  if (!user.ally_id || !can(db, user, 'forum')) return { ok: false, error: 'denied' };
  db.prepare('UPDATE forum_thread SET board_id = NULL WHERE board_id = ? AND ally_id = ?').run(boardId, user.ally_id);
  db.prepare('DELETE FROM forum_board WHERE id = ? AND ally_id = ?').run(boardId, user.ally_id);
  return { ok: true };
}

function reply(db, user, threadId, body) {
  return transaction(db, () => {
    const th = db.prepare('SELECT * FROM forum_thread WHERE id = ? AND ally_id = ?').get(threadId, user.ally_id);
    if (!th) return { ok: false, error: 'noThread' };
    if (th.closed && !can(db, user, 'forum')) return { ok: false, error: 'closed' };
    body = String(body || '').trim().slice(0, 20000);
    if (!body) return { ok: false, error: 'empty' };
    const t = now();
    db.prepare('INSERT INTO forum_post (thread_id, user_id, body, time) VALUES (?,?,?,?)').run(th.id, user.id, body, t);
    db.prepare('UPDATE forum_thread SET updated_at = ? WHERE id = ?').run(t, th.id);
    return { ok: true };
  });
}

function moderate(db, user, threadId, action, postId) {
  return transaction(db, () => {
    const th = db.prepare('SELECT * FROM forum_thread WHERE id = ? AND ally_id = ?').get(threadId, user.ally_id);
    if (!th) return { ok: false, error: 'noThread' };
    const mod = can(db, user, 'forum');
    if (action === 'delete_post') {
      const post = db.prepare('SELECT * FROM forum_post WHERE id = ? AND thread_id = ?').get(postId, th.id);
      if (!post || (!mod && post.user_id !== user.id)) return { ok: false, error: 'denied' };
      db.prepare('DELETE FROM forum_post WHERE id = ?').run(post.id);
      if (!db.prepare('SELECT 1 FROM forum_post WHERE thread_id = ?').get(th.id)) db.prepare('DELETE FROM forum_thread WHERE id = ?').run(th.id);
      return { ok: true };
    }
    if (!mod) return { ok: false, error: 'denied' };
    if (action === 'close') db.prepare('UPDATE forum_thread SET closed = 1 WHERE id = ?').run(th.id);
    else if (action === 'open') db.prepare('UPDATE forum_thread SET closed = 0 WHERE id = ?').run(th.id);
    else if (action === 'delete') db.prepare('DELETE FROM forum_thread WHERE id = ?').run(th.id);
    else return { ok: false, error: 'badAction' };
    return { ok: true };
  });
}

const openApplications = (db, user) => (user.ally_id && can(db, user, 'invite') ? db.prepare('SELECT COUNT(*) AS n FROM ally_application WHERE ally_id = ?').get(user.ally_id).n : 0);

const unreadThreads = (db, user) => (user.ally_id ? db.prepare(`SELECT COUNT(*) AS n FROM forum_thread t WHERE t.ally_id = ? AND t.updated_at > COALESCE((SELECT time FROM forum_read r WHERE r.thread_id = t.id AND r.user_id = ?), 0) AND t.user_id != ?`).get(user.ally_id, user.id, user.id).n : 0);

module.exports = {
  apply, applicationsOf, answerApplication, openApplications, RIGHTS, rightsOf, isLeader, can, members, found, invite, accept, leave, kick, setMember, transferLead, disband, rename,
  contracts, incomingProposals, propose, answerProposal, cancelContract, relation, threads, newThread, reply, moderate, pollOf, vote, addBoard, deleteBoard, unreadThreads, log,
};

// Membership changes alter the tribe rankings straight away.
for (const name of ['found', 'accept', 'leave', 'kick', 'disband', 'rename', 'answerApplication']) {
  const original = module.exports[name];
  module.exports[name] = (...args) => { const r = original(...args); ranking.invalidate(); return r; };
}
