'use strict';
const cfg = require('./src/config');
const { open } = require('./src/db');
const { createApp } = require('./src/app');

// An incomplete upload shows up as broken images; say so right at the start.
const lost = require('./scripts/check-assets').missing();
if (lost.length) console.warn(`WARNING: ${lost.length} files are missing in public/ (e.g. ${lost.slice(0, 3).join(', ')}). Upload the folder again; check with: node scripts/check-assets.js`);

const port = Number(process.env.PORT || 3100);
const host = process.env.HOST || '0.0.0.0';
const db = open(process.env.DB_FILE);
const seeded = require('./src/game/world').seedBarbarians(db);
if (seeded) console.log(`Created ${seeded} barbarian villages`);
require('./src/game/world').giveBarbarianTroops(db);
require('./src/game/relics').seed(db);

// Resolve arriving commands even while nobody is looking at the page.
const commands = require('./src/game/commands');
setInterval(() => { try { if (!cfg.PAUSED) commands.processDue(db); } catch (e) { console.error('tick failed', e); } }, 1000).unref();

// Automatic backups of the database (settings in the admin area).
const backup = require('./src/backup');
const settings = require('./src/settings');
setInterval(() => { try { const f = backup.maybeRun(db, settings.load(db)); if (f) console.log(`Backup written: ${f}`); } catch (e) { console.error('backup failed', e); } }, 10 * 60 * 1000).unref();
setTimeout(() => { try { backup.maybeRun(db, settings.load(db)); } catch (e) { console.error('backup failed', e); } }, 15 * 1000).unref();

// Players who stayed away for the configured number of days are removed (off when the setting is 0).
const players = require('./src/game/players');
const sweep = () => { try { if (!cfg.PAUSED) { const gone = players.sweepInactive(db, settings.inactiveDays(db)); if (gone.length) console.log(`Inactive accounts removed: ${gone.join(', ')}`); } } catch (e) { console.error('sweep failed', e); } };
setInterval(sweep, 60 * 60 * 1000).unref();
setTimeout(sweep, 30 * 1000).unref();

// Bots take their turns on the same clock.
const bots = require('./src/game/bots');
setInterval(() => { try { if (!cfg.PAUSED) bots.tick(db); } catch (e) { console.error('bot tick failed', e); } }, 2000).unref();
const app = createApp(db, {
  trustProxy: process.env.TRUST_PROXY === '0' ? false : 1,
  registrationOpen: process.env.REGISTRATION !== 'closed',
});
app.listen(port, host, () => console.log(`TWLan listening on http://${host}:${port}`));
