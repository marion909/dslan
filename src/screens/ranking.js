'use strict';
const ranking = require('../game/ranking');
const village = require('../game/village');
const { t } = require('../view');

const MODES = ['player', 'ally', 'con_player', 'con_ally', 'kill_player', 'kill_ally', 'wars'];
const PAGE = 25;

module.exports = ({ db, render }) => ({
  async ranking(ctx) {
    const { req, v } = ctx;
    const mode = MODES.includes(ctx.mode) ? ctx.mode : 'player';
    const con = String(req.query.con || ranking.continentOf(v.x, v.y)).replace(/\D/g, '').slice(0, 2) || '00';
    let rows;
    switch (mode) {
      case 'ally': rows = ranking.allies(db); break;
      case 'con_player': rows = ranking.playersContinent(db, con); break;
      case 'con_ally': rows = ranking.alliesContinent(db, con); break;
      case 'kill_player': rows = ranking.playersKills(db, ['att', 'def'].includes(req.query.kind) ? req.query.kind : 'all'); break;
      case 'kill_ally': rows = ranking.alliesKills(db); break;
      default: rows = ranking.players(db);
    }
    if (mode === 'wars') return render(ctx, 'ranking', { mode, modes: MODES, wars: ranking.wars(db), rows: [], from: 0, total: 0, page: PAGE, con, search: '', ownId: 0, myIndex: -1, kind: 'all' }, { title: t('game.menu.ranking.title'), mode });
    const search = String(req.query.name || '').trim().toLowerCase();
    let from = Math.max(0, Number(req.query.from) || 0);
    if (search) {
      const idx = rows.findIndex((r) => r.name.toLowerCase().includes(search) || (r.tag || '').toLowerCase() === search);
      if (idx >= 0) from = Math.floor(idx / PAGE) * PAGE;
    }
    const own = mode.endsWith('ally') ? req.user.ally_id : req.user.id;
    const myIndex = rows.findIndex((r) => r.id === own);
    return render(ctx, 'ranking', {
      mode, rows: rows.slice(from, from + PAGE), from, total: rows.length, page: PAGE, con, search, ownId: own, myIndex, modes: MODES, villagePoints: village.villagePoints,
      kind: ['att', 'def'].includes(req.query.kind) ? req.query.kind : 'all',
    }, { title: t('game.menu.ranking.title'), mode });
  },
});
