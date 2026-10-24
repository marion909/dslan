'use strict';
const crypto = require('node:crypto');

const SESSION_TTL = 30 * 24 * 3600;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

function createSession(db, userId) {
  const sid = crypto.randomBytes(32).toString('hex');
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL;
  db.prepare('INSERT INTO session (sid, user_id, expires_at) VALUES (?,?,?)').run(sid, userId, expires);
  return { sid, maxAge: SESSION_TTL * 1000 };
}

function userForSession(db, sid) {
  if (!sid) return null;
  return db.prepare(
    'SELECT u.* FROM session s JOIN user u ON u.id = s.user_id WHERE s.sid = ? AND s.expires_at > ? AND u.banned = 0',
  ).get(sid, Math.floor(Date.now() / 1000)) || null;
}

// A sitter works inside the owner's account; the session remembers whose account that currently is.
function sittingFor(db, sid, sitterId) {
  const row = db.prepare('SELECT sit_for FROM session WHERE sid = ?').get(sid);
  if (!row || !row.sit_for) return null;
  if (!db.prepare('SELECT 1 FROM sitter WHERE owner_id = ? AND sitter_id = ?').get(row.sit_for, sitterId)) return null;
  return db.prepare('SELECT * FROM user WHERE id = ? AND banned = 0').get(row.sit_for) || null;
}

// Sliding-window limiter, keyed by IP; enough to slow password guessing on a public host.
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const list = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(req.ip, list);
    if (hits.size > 10000) hits.clear();
    if (list.length > max) return res.status(429).json({ error: 'Too many attempts, try again later.' });
    next();
  };
}

// Anti-CSRF token for the game's POST requests (sent as `h`), bound to the session.
function secretFor(db) {
  let row = db.prepare("SELECT value FROM meta WHERE key = 'secret'").get();
  if (!row) {
    row = { value: crypto.randomBytes(32).toString('hex') };
    db.prepare("INSERT INTO meta (key, value) VALUES ('secret', ?)").run(row.value);
  }
  return row.value;
}

function csrfToken(db, sid) {
  return crypto.createHmac('sha256', secretFor(db)).update(sid).digest('hex').slice(0, 16);
}

function checkCsrf(db, sid, token) {
  const expected = Buffer.from(csrfToken(db, sid));
  const given = Buffer.from(String(token || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// Recovery code: shown once, kept only as a hash. It lets a player set a new password without e-mail.
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRecoveryCode() {
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
  return chars.match(/.{4}/g).join('-');
}
const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

module.exports = { newRecoveryCode, normalizeCode, csrfToken, checkCsrf, hashPassword, verifyPassword, createSession, userForSession, sittingFor, rateLimiter };
