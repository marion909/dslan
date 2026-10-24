'use strict';
const A = require('../game/ally');
const ranking = require('../game/ranking');
const { t, dateText } = require('../view');

const reservations = require('../game/reservations');

const MODES = ['overview', 'profile', 'members', 'invite', 'diplomaty', 'forum', 'reservations', 'events', 'props'];
const ERR = {
  denied: 'Dazu fehlt dir die Berechtigung.', alreadyMember: 'Du bist bereits in einem Stamm.', badName: 'Der Name muss 3 bis 32 Zeichen lang sein.',
  badTag: 'Das Kürzel muss 2 bis 6 Zeichen lang sein.', taken: 'Name oder Kürzel sind schon vergeben.', noUser: 'Spieler nicht gefunden.',
  noInvite: 'Keine Einladung vorhanden.', tooManyApplications: 'Du kannst dich höchstens bei 3 Stämmen gleichzeitig bewerben.', noApplication: 'Bewerbung nicht gefunden.', full: 'Der Stamm ist voll.', leader: 'Der Stammesführer kann das nicht tun.', noAlly: 'Stamm nicht gefunden.',
  empty: 'Bitte alles ausfüllen.', closed: 'Das Thema ist geschlossen.', noThread: 'Thema nicht gefunden.', noProposal: 'Kein Vorschlag vorhanden.', badType: 'Ungültiger Vertrag.',
};

module.exports = ({ db, render, csrfOk }) => ({
  async ally(ctx) {
    const { req, res, vid } = ctx;
    const me = req.user;
    const ally = me.ally_id ? db.prepare('SELECT * FROM ally WHERE id = ?').get(me.ally_id) : null;
    const base = `/game.php?village=${vid}&screen=ally`;
    let message = ''; let ok = false;
    const flash = (r, text = 'Gespeichert.') => { if (r.ok) { ok = true; message = text; } else message = ERR[r.error] || t('error.technical'); };

    // Not in a tribe: found one or answer invitations.
    if (!ally) {
      if (req.method === 'POST') {
        if (!csrfOk(req)) return res.status(403).send('Invalid token');
        const act = req.query.action;
        if (act === 'found') { const r = A.found(db, me, req.body.name, req.body.tag); if (r.ok) return res.redirect(`${base}&mode=profile`); flash(r); }
        else if (act === 'accept') { const r = A.accept(db, me, Number(req.body.ally)); if (r.ok) return res.redirect(base); flash(r); }
        else if (act === 'apply') { const r = A.apply(db, me, Number(req.body.ally), req.body.text); flash(r, 'Bewerbung gesendet.'); }
        else if (act === 'withdraw') { db.prepare('DELETE FROM ally_application WHERE ally_id = ? AND user_id = ?').run(Number(req.body.ally), me.id); return res.redirect(base); }
        else if (act === 'decline') { db.prepare('DELETE FROM ally_invite WHERE ally_id = ? AND user_id = ?').run(Number(req.body.ally), me.id); return res.redirect(base); }
      }
      const invites = db.prepare('SELECT i.ally_id, a.name, a.tag, i.time FROM ally_invite i JOIN ally a ON a.id = i.ally_id WHERE i.user_id = ?').all(me.id);
      const mine = new Set(db.prepare('SELECT ally_id FROM ally_application WHERE user_id = ?').all(me.id).map((r) => r.ally_id));
      const tribes = ranking.allies(db).slice(0, 50).map((r) => ({ ...r, applied: mine.has(r.id) }));
      return render(ctx, 'ally', { noAlly: true, invites, tribes, message, ok, mode: 'overview', modes: MODES, dateText }, { title: t('game.menu.ally.title'), mode: 'overview' });
    }

    const mode = MODES.includes(ctx.mode) ? ctx.mode : 'overview';
    const leader = A.isLeader(db, me);
    const can = (r) => A.can(db, me, r);

    if (req.method === 'POST') {
      if (!csrfOk(req)) return res.status(403).send('Invalid token');
      const act = req.query.action;
      const body = req.body;
      if (act === 'save_profile') {
        if (!can('profile')) message = ERR.denied;
        else { db.prepare('UPDATE ally SET description = ?, intro = ? WHERE id = ?').run(String(body.description || '').slice(0, 5000), String(body.intro || '').slice(0, 2000), ally.id); flash({ ok: true }); }
      } else if (act === 'invite') flash(A.invite(db, me, body.name), 'Einladung verschickt.');
      else if (act === 'applicant') flash(A.answerApplication(db, me, Number(body.user), body.accept === '1'), 'Erledigt.');
      else if (act === 'unreserve') { const r = reservations.toggle(db, me, Number(body.village)); flash(r.ok ? { ok: true } : { ok: false, error: 'denied' }, 'Reservierung aufgehoben.'); }
      else if (act === 'reserve') {
        const m = /(\d{1,3})\s*[|:,. ]\s*(\d{1,3})/.exec(String(body.coord || ''));
        const target = m && db.prepare('SELECT id FROM village WHERE x = ? AND y = ?').get(Number(m[1]), Number(m[2]));
        if (!target) message = 'Dorf nicht gefunden (Format x|y).';
        else if (reservations.forVillage(db, target.id)) message = 'Das Dorf ist schon reserviert.';
        else { const r = reservations.toggle(db, me, target.id); if (r.ok) { ok = true; message = 'Reserviert.'; } else message = 'Das geht nicht.'; }
      } else if (act === 'uninvite') { if (can('invite')) db.prepare('DELETE FROM ally_invite WHERE ally_id = ? AND user_id = ?').run(ally.id, Number(body.user)); }
      else if (act === 'kick') flash(A.kick(db, me, Number(body.user)), 'Mitglied ausgeschlossen.');
      else if (act === 'member') flash(A.setMember(db, me, Number(body.user), { title: body.title, rights: [].concat(body.rights || []) }));
      else if (act === 'lead') flash(A.transferLead(db, me, Number(body.user)), 'Führung übergeben.');
      else if (act === 'leave') { const r = A.leave(db, me); if (r.ok) return res.redirect(base); flash(r); }
      else if (act === 'disband') { const r = A.disband(db, me); if (r.ok) return res.redirect(base); flash(r); }
      else if (act === 'rename') flash(A.rename(db, me, body.name, body.tag));
      else if (act === 'propose') flash(A.propose(db, me, Number((db.prepare('SELECT id FROM ally WHERE name = ? OR tag = ?').get(String(body.other || '').trim(), String(body.other || '').trim()) || {}).id), body.type), 'Vorschlag gesendet.');
      else if (act === 'answer') flash(A.answerProposal(db, me, Number(body.from), body.accept === '1'), 'Erledigt.');
      else if (act === 'cancel_contract') flash(A.cancelContract(db, me, Number(body.other)), 'Vertrag beendet.');
      else if (act === 'thread') { const r = A.newThread(db, me, body.title, body.body, { board: Number(body.board) || null, poll: body.poll, options: String(body.options || '').split('\n') }); if (r.ok) return res.redirect(`${base}&mode=forum&thread=${r.id}`); flash(r); }
      else if (act === 'vote') { const r = A.vote(db, me, Number(req.query.thread), Number(body.option)); if (r.ok) return res.redirect(`${base}&mode=forum&thread=${req.query.thread}`); flash(r); }
      else if (act === 'board_add') flash(A.addBoard(db, me, body.name), 'Unterforum angelegt.');
      else if (act === 'board_delete') flash(A.deleteBoard(db, me, Number(body.board)), 'Unterforum gelöscht.');
      else if (act === 'reply') { const r = A.reply(db, me, Number(req.query.thread), body.body); if (r.ok) return res.redirect(`${base}&mode=forum&thread=${req.query.thread}`); flash(r); }
      else if (act === 'moderate') { const r = A.moderate(db, me, Number(req.query.thread), body.do, Number(body.post)); if (r.ok) return res.redirect(body.do === 'delete' ? `${base}&mode=forum` : `${base}&mode=forum&thread=${req.query.thread}`); flash(r); }
    }

    const fresh = db.prepare('SELECT * FROM ally WHERE id = ?').get(me.ally_id) || ally;
    const locals = { me, noAlly: false, mode, modes: MODES, ally: fresh, leader, can: { invite: can('invite'), members: can('members'), diplomacy: can('diplomacy'), forum: can('forum'), profile: can('profile'), mail: can('mail') }, message, ok, dateText, rights: A.RIGHTS, base };
    const rk = ranking.allies(db).find((r) => r.id === ally.id);
    locals.rank = rk ? rk.rank : '-'; locals.points = rk ? rk.points : 0;
    locals.members = A.members(db, ally.id).map((m) => ({ ...m, rights: A.rightsOf(m), points: (ranking.players(db).find((p) => p.id === m.id) || {}).points || 0, isLeader: m.id === fresh.leader_id }));
    if (mode === 'invite') locals.applications = A.applicationsOf(db, ally.id);
    if (mode === 'invite') locals.invites = db.prepare('SELECT i.user_id, u.name, i.time FROM ally_invite i JOIN user u ON u.id = i.user_id WHERE i.ally_id = ?').all(ally.id);
    if (mode === 'diplomaty') { locals.contracts = A.contracts(db, ally.id); locals.proposals = A.incomingProposals(db, ally.id); }
    if (mode === 'reservations') locals.reservations = reservations.forTribe(db, ally.id).map((r) => ({ ...r, mine: r.user_id === me.id }));
    if (mode === 'events') locals.events = db.prepare('SELECT * FROM ally_event WHERE ally_id = ? ORDER BY time DESC, id DESC LIMIT 100').all(ally.id);
    if (mode === 'forum') {
      const threadId = Number(req.query.thread) || 0;
      if (threadId) {
        const th = db.prepare('SELECT t.*, u.name AS author FROM forum_thread t JOIN user u ON u.id = t.user_id WHERE t.id = ? AND t.ally_id = ?').get(threadId, ally.id);
        if (th) {
          locals.thread = th;
          locals.poll = A.pollOf(db, th, me.id);
          locals.posts = db.prepare('SELECT p.*, u.name AS author FROM forum_post p JOIN user u ON u.id = p.user_id WHERE p.thread_id = ? ORDER BY p.time, p.id').all(th.id);
          db.prepare('INSERT INTO forum_read (user_id, thread_id, time) VALUES (?,?,?) ON CONFLICT(user_id, thread_id) DO UPDATE SET time = excluded.time').run(me.id, th.id, Math.floor(Date.now() / 1000));
        }
      }
      locals.boards = db.prepare('SELECT b.*, (SELECT COUNT(*) FROM forum_thread t WHERE t.board_id = b.id) AS count FROM forum_board b WHERE b.ally_id = ? ORDER BY b.name').all(ally.id);
      locals.board = locals.boards.find((b) => b.id === Number(req.query.board)) || null;
      if (!locals.thread) locals.threads = A.threads(db, ally.id, me.id, locals.board ? locals.board.id : null);
      locals.newThread = req.query.new === '1';
    }
    return render(ctx, 'ally', locals, { title: ally.name, mode });
  },

  async info_ally(ctx) {
    const { req, res, vid } = ctx;
    const ally = db.prepare('SELECT * FROM ally WHERE id = ?').get(Number(req.query.id) || req.user.ally_id || 0);
    if (!ally) return res.redirect(`/game.php?village=${vid}&screen=ally`);
    const rk = ranking.allies(db).find((r) => r.id === ally.id) || { rank: '-', points: 0, villages: 0 };
    const players = ranking.players(db);
    const list = A.members(db, ally.id).map((m) => ({ ...m, points: (players.find((p) => p.id === m.id) || {}).points || 0 }));
    const treaties = A.contracts(db, ally.id).filter((c) => ['partner', 'nap', 'enemy'].includes(c.type));
    return render(ctx, 'info_ally', { ally, rank: rk.rank, points: rk.points, villages: rk.villages, members: list, treaties, created: dateText(ally.created_at) }, { title: ally.name });
  },
});
