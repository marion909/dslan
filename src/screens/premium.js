'use strict';
const premium = require('../game/premium');
const { dateText } = require('../view');

module.exports = ({ db, render }) => ({
  async premium(ctx) {
    const { req } = ctx;
    return render(ctx, 'premium', {
      balance: premium.balance(db, req.user.id), isAdmin: !!req.user.is_admin, dateText,
      log: db.prepare('SELECT time, delta, reason FROM pp_log WHERE user_id = ? ORDER BY time DESC, id DESC LIMIT 30').all(req.user.id),
    }, { title: 'Premium-Punkte' });
  },
});
