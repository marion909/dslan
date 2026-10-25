'use strict';
const cfg = require('../config');
const auth = require('../auth');
const { t } = require('../view');
const players = require('../game/players');

const MODES = ['profile', 'settings', 'notify', 'quickbar', 'logins', 'block', 'change_passwd', 'recovery', 'sitter', 'vacation', 'delete', 'world'];

// Readable names for the world settings players care about.
const WORLD_ROWS = [
  ['name', 'Welt'], ['speed', 'Spielgeschwindigkeit'], ['unitsSpeed', 'Einheitengeschwindigkeit'], ['mapSize', 'Kartengröße'], ['beginnerProtection', 'Angriffsschutz (Minuten)'],
  ['morale', 'Moral'], ['nightBonus', 'Nachtbonus (Verteidigung)'], ['nightStart', 'Nacht von'], ['nightEnd', 'Nacht bis'], ['basicDefense', 'Grundverteidigung'],
  ['noblemanSystem', 'Adelssystem'], ['noblemanRange', 'Reichweite des Adels (Felder)'], ['noblemanMinDecrease', 'Zustimmungsverlust min.'], ['noblemanMaxDecrease', 'Zustimmungsverlust max.'],
  ['tribeMemberLimit', 'Maximale Stammesgröße'], ['buildqueueStart', 'Länge der Bauschleife'], ['knightActive', 'Paladin'], ['destroyBuildings', 'Gebäude zerstören'],
  ['attackSelf', 'Eigene Dörfer angreifen'], ['restart', 'Neues Dorf nach Verlust'], ['church', 'Kirche'], ['flagsActive', 'Flaggen'], ['fakeLimit', 'Fake-Limit'],
];

// Screens a quick link may point to ("screen" or "screen&mode=x").
const QUICK_TARGETS = [
  ['main', 'Hauptgebäude'], ['barracks', 'Kaserne'], ['stable', 'Stall'], ['garage', 'Werkstatt'], ['smith', 'Schmiede'], ['snob', 'Adelshof'],
  ['place', 'Versammlungsplatz'], ['place&mode=units', 'Truppenübersicht'], ['place&mode=sim', 'Simulator'], ['market', 'Marktplatz'], ['statue', 'Statue'], ['wall', 'Wall'],
  ['overview', 'Dorfübersicht'], ['overview_villages', 'Übersichten'], ['map', 'Karte'], ['report', 'Berichte'], ['mail', 'Nachrichten'], ['ranking', 'Rangliste'],
  ['ally', 'Stamm'], ['ally&mode=forum', 'Stammesforum'], ['quests', 'Aufgaben'], ['notes', 'Notizblock'],
];
const QUICK_MAX = 12;

const NOTIFY_DEFAULTS = { browser: 0, sound: 0, attack: 1, message: 1, report: 1 };
const notifyPrefs = (json) => { try { return { ...NOTIFY_DEFAULTS, ...JSON.parse(json) }; } catch { return { ...NOTIFY_DEFAULTS }; } };

module.exports = ({ db, render, csrfOk }) => ({
  async settings(ctx) {
    const { req, res, vid } = ctx;
    const mode = MODES.includes(ctx.mode) ? ctx.mode : 'profile';
    let message = ''; let ok = false; let extraCode = '';

    if (req.method === 'POST') {
      if (!csrfOk(req)) return res.status(403).send('Invalid token');
      const user = req.user;
      if (mode === 'profile') {
        const text = String(req.body.profile || '').slice(0, 2000);
        db.prepare('UPDATE user SET profile = ? WHERE id = ?').run(text, user.id);
        message = 'Gespeichert.'; ok = true;
      } else if (mode === 'settings') {
        const lang = String(req.body.lang || '');
        if (cfg.languageCodes.includes(lang)) {
          db.prepare('UPDATE user SET lang = ? WHERE id = ?').run(lang, user.id);
          return res.redirect(`/game.php?village=${vid}&screen=settings&mode=settings&saved=1`);
        }
        message = t('error.technical');
      } else if (mode === 'change_passwd') {
        const { old_password: oldPw, new_password: pw, new_password2: pw2 } = req.body;
        if (!auth.verifyPassword(String(oldPw || ''), user.password_hash)) message = 'Das aktuelle Passwort ist falsch.';
        else if (!pw || pw.length < 6 || pw.length > 100) message = 'Das neue Passwort muss 6 bis 100 Zeichen lang sein.';
        else if (pw !== pw2) message = 'Die Passwörter stimmen nicht überein.';
        else {
          db.prepare('UPDATE user SET password_hash = ? WHERE id = ?').run(auth.hashPassword(pw), user.id);
          db.prepare('DELETE FROM session WHERE user_id = ? AND sid != ?').run(user.id, req.sid); // log out other devices
          message = 'Das Passwort wurde geändert.'; ok = true;
        }
      } else if (mode === 'quickbar') {
        db.prepare('DELETE FROM quicklink WHERE user_id = ?').run(user.id);
        if (req.body.reset !== '1') {
          let pos = 0;
          for (let i = 0; i < QUICK_MAX; i++) {
            const target = String(req.body[`target_${i}`] || '');
            const label = String(req.body[`label_${i}`] || '').trim().slice(0, 20);
            if (!label || !QUICK_TARGETS.some(([k]) => k === target)) continue;
            db.prepare('INSERT INTO quicklink (user_id, pos, label, target) VALUES (?,?,?,?)').run(user.id, pos++, label, target);
          }
        }
        message = 'Gespeichert.'; ok = true;
      } else if (mode === 'notify') {
        const flag = (k) => (req.body[k] === '1' ? 1 : 0);
        const prefs = { browser: flag('browser'), sound: flag('sound'), attack: flag('attack'), message: flag('message'), report: flag('report') };
        db.prepare('UPDATE user SET notify = ? WHERE id = ?').run(JSON.stringify(prefs), user.id);
        message = 'Gespeichert.'; ok = true;
      } else if (mode === 'recovery') {
        if (!auth.verifyPassword(String(req.body.password || ''), user.password_hash)) message = 'Das Passwort ist falsch.';
        else {
          const code = auth.newRecoveryCode();
          db.prepare('UPDATE user SET recovery_hash = ? WHERE id = ?').run(auth.hashPassword(auth.normalizeCode(code)), user.id);
          extraCode = code; ok = true; message = 'Dein neuer Wiederherstellungscode ist erstellt.';
        }
      } else if (mode === 'vacation') {
        const days = players.setVacation(db, user.id, req.body.days);
        message = days ? `Urlaub eingetragen: Dein Konto wird ${days} Tage lang nicht wegen Inaktivität gelöscht.` : 'Urlaub beendet.'; ok = true;
      } else if (mode === 'sitter') {
        if (req.query.action === 'remove') db.prepare('DELETE FROM sitter WHERE owner_id = ? AND sitter_id = ?').run(user.id, Number(req.body.other));
        else {
          const other = db.prepare('SELECT id FROM user WHERE name = ?').get(String(req.body.name || '').trim());
          if (!other || other.id === user.id) message = 'Spieler nicht gefunden.';
          else { db.prepare('INSERT OR IGNORE INTO sitter (owner_id, sitter_id) VALUES (?,?)').run(user.id, other.id); message = 'Sitter eingetragen.'; ok = true; }
        }
      } else if (mode === 'block') {
        if (req.query.action === 'unblock') db.prepare('DELETE FROM blocked WHERE user_id = ? AND other_id = ?').run(user.id, Number(req.body.other));
        else {
          const other = db.prepare('SELECT id FROM user WHERE name = ?').get(String(req.body.name || '').trim());
          if (!other || other.id === user.id) message = 'Spieler nicht gefunden.';
          else { db.prepare('INSERT OR IGNORE INTO blocked (user_id, other_id) VALUES (?,?)').run(user.id, other.id); message = 'Spieler blockiert.'; ok = true; }
        }
      } else if (mode === 'delete') {
        if (!auth.verifyPassword(String(req.body.password || ''), user.password_hash) || req.body.confirm !== '1') {
          message = 'Passwort falsch oder Bestätigung fehlt.';
        } else {
          players.removePlayer(db, user.id);
          players.log(db, `Spieler hat sein Konto gelöscht: ${user.name}`);
          res.clearCookie('twsid');
          return res.redirect('/');
        }
      }
    }
    if (req.query.saved) { message = 'Gespeichert.'; ok = true; }
    const fresh = db.prepare('SELECT * FROM user WHERE id = ?').get(req.user.id);
    const extra = { code: extraCode, hasCode: !!db.prepare('SELECT recovery_hash FROM user WHERE id = ?').get(req.user.id).recovery_hash };
    if (mode === 'vacation') extra.vacationUntil = db.prepare('SELECT vacation_until FROM user WHERE id = ?').get(req.user.id).vacation_until;
    if (mode === 'vacation') extra.maxVacation = players.MAX_VACATION_DAYS;
    if (mode === 'notify') extra.prefs = notifyPrefs(db.prepare('SELECT notify FROM user WHERE id = ?').get(req.user.id).notify);
    if (mode === 'world') {
      const w = cfg.world;
      const show = (v) => (v === true ? 'ja' : v === false ? 'nein' : v);
      extra.worldRows = WORLD_ROWS.filter(([k]) => k in w).map(([k, label]) => [label, k === 'speed' ? `${cfg.SPEED}x` : show(w[k])]);
    }
    if (mode === 'quickbar') {
      extra.quick = db.prepare('SELECT label, target FROM quicklink WHERE user_id = ? ORDER BY pos').all(req.user.id);
      extra.targets = QUICK_TARGETS; extra.slots = QUICK_MAX;
    } else if (mode === 'logins') extra.logins = db.prepare('SELECT time, ip FROM login_log WHERE user_id = ? ORDER BY time DESC, id DESC LIMIT 30').all(req.user.id);
    else if (mode === 'sitter') {
      extra.sitters = db.prepare('SELECT u.id, u.name FROM sitter s JOIN user u ON u.id = s.sitter_id WHERE s.owner_id = ? ORDER BY u.name').all(req.user.id);
      extra.sitFor = db.prepare('SELECT u.id, u.name FROM sitter s JOIN user u ON u.id = s.owner_id WHERE s.sitter_id = ? ORDER BY u.name').all(req.user.id);
    } else if (mode === 'block') extra.blocked = db.prepare('SELECT u.id, u.name FROM blocked b JOIN user u ON u.id = b.other_id WHERE b.user_id = ? ORDER BY u.name').all(req.user.id);
    return render(ctx, 'settings', { ...extra, dateText: require('../view').dateText, mode, modes: MODES, message, ok, me: fresh, languages: cfg.languageCodes.map((c) => [c, cfg.languageNames[c] || c]), defaultLang: cfg.LANG }, { title: t('game.menu.settings.title'), mode });
  },
});
