'use strict';
// Collects the screen handlers of every module into one { screenName: handler } table.
const MODULES = ['./overview', './map', './report', './units', './settings', './ranking', './mail', './profile', './ally', './place', './main', './buildings', './villages', './colorgroups', './premium', './relics', './masstrain', './unitinfo', './misc'];

// No prototype, so a request for screen=toString can never reach Object.prototype.
module.exports = (deps) => Object.assign(Object.create(null), ...MODULES.map((m) => {
  try { return require(m)(deps); } catch (e) { if (e.code === 'MODULE_NOT_FOUND' && e.message.includes(m.slice(2))) return {}; throw e; }
}));
