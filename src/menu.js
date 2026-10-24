'use strict';
// Top navigation of the game screen. `items` become the drop-down column; each is
// { label: translation key, mode, screen? } (screen defaults to the entry's own).
const it = (label, mode, screen) => ({ label, mode, screen });

module.exports = [
  { key: 'overview', screen: 'overview_villages', items: [
    it('game.menu.overview.combined', 'combined'), it('game.menu.overview.prod', 'prod'), it('game.menu.overview.units', 'units'),
    it('game.menu.overview.buildings', 'buildings'), it('game.menu.overview.commands', 'commands'), it('game.menu.overview.incomings', 'incomings'),
    it('game.menu.overview.tech', 'tech'), it('game.menu.overview.groups', 'groups'), it('game.menu.overview.trader', 'trader'),
  ] },
  { key: 'map', screen: 'map', titleKey: 'game.menu.map' },
  { key: 'reports', screen: 'report', items: [
    it('game.menu.reports.all', 'all'), it('game.menu.reports.attack', 'attack'), it('game.menu.reports.defense', 'defense'),
    it('game.menu.reports.support', 'support'), it('game.menu.reports.trade', 'trade'), it('game.menu.reports.other', 'other'), it('game.menu.reports.forwarded', 'forwarded'),
    it('game.menu.reports.public', 'public'), it('game.menu.reports.filter', 'filter'),
  ] },
  { key: 'mails', screen: 'mail', items: [
    it('game.menu.mails.in', 'in'), it('game.menu.mails.new', 'new'), it('game.menu.mails.massOut', 'mass_out'), it('game.menu.mails.address', 'address'),
  ] },
  { key: 'ally', screen: 'ally', items: [
    it('game.menu.ally.overview', 'overview'), it('game.menu.ally.profile', 'profile'), it('game.menu.ally.members', 'members'),
    it('game.menu.ally.contracts', 'diplomaty'), it('game.menu.ally.forum', 'forum'), it('game.menu.ally.reservations', 'reservations'),
  ] },
  { key: 'profile', screen: 'info_player', items: [
    it('game.menu.profile.title', '', 'info_player'), it('game.menu.profile.friends', 'address', 'mail'), it('game.menu.profile.achievements', '', 'achievements'),
    it('game.menu.profile.inventory', 'inventory', 'statue'), it('Reliquien', '', 'relics'), it('game.menu.profile.statistics', 'player', 'ranking'),
  ] },
  // Premium points: the label shows the balance (see game.ejs).
  { key: 'premium', screen: 'premium', titleKey: 'game.menu.premium' },
  { key: 'settings', screen: 'settings', items: [
    it('game.menu.settings.profile', 'profile'), it('game.menu.settings.settings', 'settings'), it('game.menu.settings.changePasswd', 'change_passwd'),
    it('game.menu.settings.quickbar', 'quickbar'), it('game.menu.settings.logins', 'logins'), it('game.menu.settings.block', 'block'), it('game.menu.settings.sitter', 'sitter'),
    it('game.menu.settings.delete', 'delete'),
  ] },
];

// The ranking box in the top bar shows rank and points; its drop-down lists the ranking views.
module.exports.rankingItems = [
  it('game.menu.ranking.player', 'player'), it('game.menu.ranking.ally', 'ally'), it('game.menu.ranking.conPlayer', 'con_player'), it('game.menu.ranking.conAlly', 'con_ally'),
  it('game.menu.ranking.killPlayer', 'kill_player'), it('game.menu.ranking.killAlly', 'kill_ally'), it('game.menu.ranking.wars', 'wars'),
];
