'use strict';
const quests = require('../game/quests');
const { t } = require('../view');

// Longer-term milestones; only shown, never paid out.
const AWARDS = [
  { id: 'points', title: 'Punkte', steps: [100, 500, 1000, 5000, 10000], get: (s) => s.points },
  { id: 'villages', title: 'Dörfer', steps: [2, 3, 5, 10], get: (s) => s.villages },
  { id: 'kills', title: 'Besiegte Gegner', steps: [100, 1000, 10000, 100000], get: (s) => s.kills },
  { id: 'attacks', title: 'Angriffe', steps: [1, 10, 50, 200], get: (s) => s.attacks },
  { id: 'conquered', title: 'Eroberte Dörfer', steps: [1, 3, 10], get: (s) => s.conquered },
  { id: 'items', title: 'Paladin-Gegenstände', steps: [1, 4, 8, 11], get: (s) => s.items },
];

module.exports = ({ db, render, csrfOk }) => {
  const stats = (user) => quests.stats(db, user);
  const to = (ctx, screen, extra = '') => ctx.res.redirect(`/game.php?village=${ctx.vid}&screen=${screen}${extra}`);

  return {
    async quests(ctx) {
      const { req, res } = ctx;
      const me = req.user;
      let message = '';
      if (req.method === 'POST') {
        if (!csrfOk(req)) return res.status(403).send('Invalid token');
        if (quests.claim(db, me, ctx.vid, String(req.body.quest)).ok) return to(ctx, 'quests');
        message = t('error.technical');
      }
      const s = stats(me);
      const done = quests.claimed(db, me.id);
      return render(ctx, 'quests', { message, quests: quests.QUESTS.map((q) => ({ ...q, ready: q.done(s), claimed: done.has(q.id) })) }, { title: 'Aufgaben' });
    },

    async achievements(ctx) {
      const s = stats(ctx.req.user);
      const rows = AWARDS.map((a) => {
        const value = a.get(s);
        const reached = a.steps.filter((x) => value >= x).length;
        return { title: a.title, value, steps: a.steps, reached, next: a.steps.find((x) => value < x) || null };
      });
      return render(ctx, 'achievements', { rows }, { title: t('game.menu.profile.achievements') });
    },

    async event(ctx) {
      return render(ctx, 'bare', { html: '<h2>Halloween</h2><p>Es ist Halloween-Zeit! Zwar sind deine Dorfbewohner nicht in Gefahr, aber außerhalb des Walls machen grausige Geister und gruselige Skelette die Welt unsicher.</p><p>Dieses Jahr gibt es keine besonderen Aufgaben – genieße die Stimmung und verteidige dein Dorf.</p>' }, { title: 'Halloween' });
    },

    // Shortcuts that existed as separate screens in the original.
    async inventory(ctx) { return to(ctx, 'statue', '&mode=inventory'); },
    async flags(ctx) { return to(ctx, 'overview'); },
  };
};
