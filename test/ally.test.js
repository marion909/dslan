'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const a = require('../src/game/ally');

function setup() {
  const db = open(':memory:');
  for (const n of ['lead', 'bob', 'cara']) db.prepare("INSERT INTO user (name, password_hash, created_at) VALUES (?, 'x', 0)").run(n);
  const user = (id) => db.prepare('SELECT * FROM user WHERE id = ?').get(id);
  return { db, user };
}

test('founding validates names and makes the founder leader', () => {
  const { db, user } = setup();
  assert.equal(a.found(db, user(1), 'x', 'AB').error, 'badName');
  const r = a.found(db, user(1), 'Die Wölfe', 'WLF');
  assert.ok(r.ok);
  assert.ok(a.isLeader(db, user(1)));
  assert.equal(a.found(db, user(2), 'Die Wölfe', 'ZZ').error, 'taken');
});

test('invite, accept, rights, kick and leaving', () => {
  const { db, user } = setup();
  a.found(db, user(1), 'Wolves', 'WLF');
  assert.equal(a.invite(db, user(2), 'cara').error, 'denied');
  assert.ok(a.invite(db, user(1), 'bob').ok);
  assert.ok(a.accept(db, user(2), 1).ok);
  assert.equal(a.members(db, 1).length, 2);
  assert.ok(a.setMember(db, user(1), 2, { title: 'Offizier', rights: ['invite', 'bogus'] }).ok);
  assert.ok(a.can(db, user(2), 'invite'));
  assert.ok(!a.can(db, user(2), 'members'));
  assert.equal(a.kick(db, user(2), 1).error, 'denied');
  assert.equal(a.leave(db, user(1)).error, 'leader');
  assert.ok(a.leave(db, user(2)).ok);
  assert.equal(user(2).ally_id, null);
});

test('diplomacy: war is immediate, treaties need acceptance', () => {
  const { db, user } = setup();
  a.found(db, user(1), 'Wolves', 'WLF');
  a.found(db, user(2), 'Bears', 'BRS');
  assert.ok(a.propose(db, user(1), 2, 'partner').ok);
  assert.equal(a.relation(db, 1, 2), null);
  assert.equal(a.incomingProposals(db, 2).length, 1);
  assert.ok(a.answerProposal(db, user(2), 1, true).ok);
  assert.equal(a.relation(db, 1, 2), 'partner');
  assert.equal(a.relation(db, 2, 1), 'partner');
  assert.ok(a.propose(db, user(1), 2, 'enemy').ok);
  assert.equal(a.relation(db, 2, 1), 'enemy');
  assert.ok(a.cancelContract(db, user(2), 1).ok);
  assert.equal(a.relation(db, 1, 2), null);
});

test('forum: members only, closing blocks replies, authors may delete their post', () => {
  const { db, user } = setup();
  a.found(db, user(1), 'Wolves', 'WLF');
  a.invite(db, user(1), 'bob'); a.accept(db, user(2), 1);
  const th = a.newThread(db, user(1), 'Plan', 'Angriff morgen');
  assert.ok(th.ok);
  assert.ok(a.reply(db, user(2), th.id, 'bin dabei').ok);
  assert.equal(a.reply(db, user(3), th.id, 'hi').error, 'noThread');
  assert.ok(a.moderate(db, user(1), th.id, 'close').ok);
  assert.equal(a.reply(db, user(2), th.id, 'zu spät').error, 'closed');
  const post = db.prepare('SELECT id FROM forum_post WHERE user_id = 2').get();
  assert.ok(a.moderate(db, user(2), th.id, 'delete_post', post.id).ok);
  assert.equal(a.threads(db, 1, 1)[0].posts, 1);
});
