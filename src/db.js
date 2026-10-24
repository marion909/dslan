'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ROOT } = require('./config');

function open(file = path.join(ROOT, 'data', 'twlan.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS user (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session (
      sid TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS village (
      id INTEGER PRIMARY KEY,
      user_id INTEGER REFERENCES user(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      wood REAL NOT NULL, stone REAL NOT NULL, iron REAL NOT NULL,
      res_updated_at REAL NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (x, y)
    );
    CREATE TABLE IF NOT EXISTS village_building (
      village_id INTEGER NOT NULL REFERENCES village(id) ON DELETE CASCADE,
      building TEXT NOT NULL,
      level INTEGER NOT NULL,
      PRIMARY KEY (village_id, building)
    );
    CREATE TABLE IF NOT EXISTS build_queue (
      id INTEGER PRIMARY KEY,
      village_id INTEGER NOT NULL REFERENCES village(id) ON DELETE CASCADE,
      building TEXT NOT NULL,
      level INTEGER NOT NULL,
      start_at REAL NOT NULL,
      finish_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS village_unit (
      village_id INTEGER NOT NULL REFERENCES village(id) ON DELETE CASCADE,
      unit TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (village_id, unit)
    );
    CREATE TABLE IF NOT EXISTS village_research (
      village_id INTEGER NOT NULL REFERENCES village(id) ON DELETE CASCADE,
      unit TEXT NOT NULL,
      level INTEGER NOT NULL,
      PRIMARY KEY (village_id, unit)
    );
    CREATE TABLE IF NOT EXISTS train_queue (
      id INTEGER PRIMARY KEY,
      village_id INTEGER NOT NULL REFERENCES village(id) ON DELETE CASCADE,
      building TEXT NOT NULL,
      unit TEXT NOT NULL,
      amount INTEGER NOT NULL,
      per_unit REAL NOT NULL,
      start_at REAL NOT NULL,
      finish_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS research_queue (
      id INTEGER PRIMARY KEY,
      village_id INTEGER NOT NULL REFERENCES village(id) ON DELETE CASCADE,
      unit TEXT NOT NULL,
      start_at REAL NOT NULL,
      finish_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS command (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      from_village INTEGER NOT NULL REFERENCES village(id) ON DELETE CASCADE,
      to_village INTEGER NOT NULL REFERENCES village(id) ON DELETE CASCADE,
      units TEXT NOT NULL,
      loot TEXT NOT NULL DEFAULT '{}',
      depart_at REAL NOT NULL,
      arrive_at REAL NOT NULL,
      name TEXT
    );
    CREATE INDEX IF NOT EXISTS command_arrive ON command (arrive_at);
    CREATE TABLE IF NOT EXISTS report (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'green',
      time REAL NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS report_user ON report (user_id, time);
    CREATE INDEX IF NOT EXISTS build_queue_finish ON build_queue (finish_at);

    CREATE TABLE IF NOT EXISTS ally (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT NOT NULL DEFAULT '',
      intro TEXT NOT NULL DEFAULT '',
      leader_id INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ally_invite (
      id INTEGER PRIMARY KEY,
      ally_id INTEGER NOT NULL REFERENCES ally(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      time INTEGER NOT NULL,
      UNIQUE (ally_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS ally_contract (
      id INTEGER PRIMARY KEY,
      ally_id INTEGER NOT NULL REFERENCES ally(id) ON DELETE CASCADE,
      other_id INTEGER NOT NULL REFERENCES ally(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      time INTEGER NOT NULL,
      UNIQUE (ally_id, other_id)
    );
    CREATE TABLE IF NOT EXISTS ally_event (
      id INTEGER PRIMARY KEY,
      ally_id INTEGER NOT NULL REFERENCES ally(id) ON DELETE CASCADE,
      time INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS forum_thread (
      id INTEGER PRIMARY KEY,
      ally_id INTEGER NOT NULL REFERENCES ally(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      closed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS forum_post (
      id INTEGER PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES forum_thread(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      time INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS forum_read (
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      thread_id INTEGER NOT NULL REFERENCES forum_thread(id) ON DELETE CASCADE,
      time INTEGER NOT NULL,
      PRIMARY KEY (user_id, thread_id)
    );
    CREATE TABLE IF NOT EXISTS message (
      id INTEGER PRIMARY KEY,
      from_id INTEGER REFERENCES user(id) ON DELETE SET NULL,
      to_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      time INTEGER NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      deleted_in INTEGER NOT NULL DEFAULT 0,
      deleted_out INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS message_to ON message (to_id, time);
    CREATE TABLE IF NOT EXISTS buddy (
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      other_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      accepted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, other_id)
    );
    CREATE TABLE IF NOT EXISTS note (
      user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
      text TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS favorite (
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      village_id INTEGER NOT NULL REFERENCES village(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, village_id)
    );
    CREATE TABLE IF NOT EXISTS troop_template (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      units TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS village_group (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS village_group_member (
      group_id INTEGER NOT NULL REFERENCES village_group(id) ON DELETE CASCADE,
      village_id INTEGER NOT NULL REFERENCES village(id) ON DELETE CASCADE,
      PRIMARY KEY (group_id, village_id)
    );
    CREATE TABLE IF NOT EXISTS stationed (
      id INTEGER PRIMARY KEY,
      owner_village INTEGER NOT NULL REFERENCES village(id) ON DELETE CASCADE,
      host_village INTEGER NOT NULL REFERENCES village(id) ON DELETE CASCADE,
      units TEXT NOT NULL,
      UNIQUE (owner_village, host_village)
    );
    CREATE TABLE IF NOT EXISTS market_offer (
      id INTEGER PRIMARY KEY,
      village_id INTEGER NOT NULL REFERENCES village(id) ON DELETE CASCADE,
      sell_res TEXT NOT NULL,
      sell_amount INTEGER NOT NULL,
      buy_res TEXT NOT NULL,
      buy_amount INTEGER NOT NULL,
      max_distance INTEGER NOT NULL DEFAULT 0,
      multi INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quicklink (
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      pos INTEGER NOT NULL,
      label TEXT NOT NULL,
      target TEXT NOT NULL,
      PRIMARY KEY (user_id, pos)
    );
    CREATE TABLE IF NOT EXISTS login_log (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      time INTEGER NOT NULL,
      ip TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS login_log_user ON login_log (user_id, time);
    CREATE TABLE IF NOT EXISTS blocked (
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      other_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, other_id)
    );
    CREATE TABLE IF NOT EXISTS reservation (
      village_id INTEGER PRIMARY KEY REFERENCES village(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      ally_id INTEGER NOT NULL REFERENCES ally(id) ON DELETE CASCADE,
      time INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS forum_board (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ally_id INTEGER NOT NULL REFERENCES ally(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS forum_poll_option (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES forum_thread(id) ON DELETE CASCADE,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS forum_poll_vote (
      thread_id INTEGER NOT NULL REFERENCES forum_thread(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      option_id INTEGER NOT NULL REFERENCES forum_poll_option(id) ON DELETE CASCADE,
      PRIMARY KEY (thread_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS sitter (
      owner_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      sitter_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      PRIMARY KEY (owner_id, sitter_id)
    );
    CREATE TABLE IF NOT EXISTS mail_folder (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS report_folder (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bot (
      user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      next_at REAL NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS bot_log (
      id INTEGER PRIMARY KEY,
      time INTEGER NOT NULL,
      user_id INTEGER,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS relic (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      effect TEXT NOT NULL,
      bonus INTEGER NOT NULL,
      site_village INTEGER NOT NULL UNIQUE REFERENCES village(id) ON DELETE CASCADE,
      assigned_village INTEGER REFERENCES village(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS pp_log (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      time INTEGER NOT NULL,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS color_group (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS color_group_member (
      group_id INTEGER NOT NULL REFERENCES color_group(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      ref_id INTEGER NOT NULL,
      PRIMARY KEY (group_id, kind, ref_id)
    );
    CREATE TABLE IF NOT EXISTS ally_application (
      ally_id INTEGER NOT NULL REFERENCES ally(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      text TEXT NOT NULL DEFAULT '',
      time INTEGER NOT NULL,
      PRIMARY KEY (ally_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS war_stat (
      ally_id INTEGER NOT NULL REFERENCES ally(id) ON DELETE CASCADE,
      other_id INTEGER NOT NULL REFERENCES ally(id) ON DELETE CASCADE,
      kills INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ally_id, other_id)
    );
    CREATE TABLE IF NOT EXISTS knight_item (
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      item TEXT NOT NULL,
      PRIMARY KEY (user_id, item)
    );
    CREATE TABLE IF NOT EXISTS quest_claim (
      user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      quest TEXT NOT NULL,
      time INTEGER NOT NULL,
      PRIMARY KEY (user_id, quest)
    );
    CREATE TABLE IF NOT EXISTS setting (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knight (
      village_id INTEGER PRIMARY KEY REFERENCES village(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'home',
      revive_at REAL
    );
  `);

  ensureColumn(db, 'message', 'folder_id', 'INTEGER');
  ensureColumn(db, 'session', 'sit_for', 'INTEGER');
  ensureColumn(db, 'forum_thread', 'board_id', 'INTEGER');
  ensureColumn(db, 'forum_thread', 'poll', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'buddy', 'grp', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'user', 'lang', "TEXT");
  ensureColumn(db, 'user', 'ally_id', 'INTEGER');
  ensureColumn(db, 'user', 'ally_title', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'user', 'ally_rights', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'user', 'profile', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'user', 'banned', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'user', 'kills_att', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'user', 'kills_def', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'build_queue', 'kind', "TEXT NOT NULL DEFAULT 'build'");
  ensureColumn(db, 'report', 'forwarded_by', 'TEXT');
  ensureColumn(db, 'user', 'recovery_hash', 'TEXT');
  ensureColumn(db, 'report', 'folder_id', 'INTEGER');
  ensureColumn(db, 'report', 'public_token', 'TEXT');
  ensureColumn(db, 'user', 'report_filter', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'user', 'notify', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'user', 'is_bot', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'user', 'pp', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'user', 'knight_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'user', 'knight_item', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'user', 'knight_progress', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'user', 'conquered', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'village', 'loyalty', 'REAL NOT NULL DEFAULT 100');
  ensureColumn(db, 'village', 'loyalty_at', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'village', 'coins', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'village', 'note', "TEXT NOT NULL DEFAULT ''");
  return db;
}

// CREATE TABLE IF NOT EXISTS leaves old tables alone, so later columns are added one by one.
function ensureColumn(db, table, column, definition) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// node:sqlite has no transaction helper. Nested calls use savepoints so that
// functions which open their own transaction can call each other.
const depth = new WeakMap();
function transaction(db, fn) {
  const d = depth.get(db) || 0;
  const name = `sp${d}`;
  db.exec(d === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  depth.set(db, d + 1);
  try {
    const result = fn();
    db.exec(d === 0 ? 'COMMIT' : `RELEASE ${name}`);
    return result;
  } catch (e) {
    db.exec(d === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
    throw e;
  } finally {
    depth.set(db, d);
  }
}

module.exports = { open, transaction };
