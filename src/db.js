'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Each entry upgrades the schema by one version. Never edit a shipped
// migration; append a new one instead.
const MIGRATIONS = [
  `
  CREATE TABLE menus (
    id          INTEGER PRIMARY KEY,
    code        TEXT    NOT NULL UNIQUE,
    title       TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    currency    TEXT    NOT NULL DEFAULT '$',
    published   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
  );

  CREATE TABLE sections (
    id          INTEGER PRIMARY KEY,
    menu_id     INTEGER NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT ''
  );
  CREATE INDEX sections_menu ON sections(menu_id, position);

  CREATE TABLE items (
    id          INTEGER PRIMARY KEY,
    section_id  INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    price       TEXT    NOT NULL DEFAULT '',
    tags        TEXT    NOT NULL DEFAULT '',
    available   INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX items_section ON items(section_id, position);
  `,
];

// Unambiguous characters only (no 0/O, 1/l/I) so a printed URL is easy to type.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function generateCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

function now() {
  return new Date().toISOString();
}

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return createStore(db);
}

function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function rowToMenu(row) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    currency: row.currency,
    published: row.published === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createStore(db) {
  const stmts = {
    list: db.prepare(`
      SELECT m.*,
        (SELECT COUNT(*) FROM sections s WHERE s.menu_id = m.id) AS section_count,
        (SELECT COUNT(*) FROM items i JOIN sections s ON s.id = i.section_id WHERE s.menu_id = m.id) AS item_count
      FROM menus m ORDER BY m.updated_at DESC, m.id DESC`),
    byId: db.prepare('SELECT * FROM menus WHERE id = ?'),
    byCode: db.prepare('SELECT * FROM menus WHERE code = ?'),
    codeExists: db.prepare('SELECT 1 FROM menus WHERE code = ?'),
    insertMenu: db.prepare(`
      INSERT INTO menus (code, title, description, currency, published, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    updateMenu: db.prepare(`
      UPDATE menus SET title = ?, description = ?, currency = ?, published = ?, updated_at = ?
      WHERE id = ?`),
    deleteMenu: db.prepare('DELETE FROM menus WHERE id = ?'),
    sections: db.prepare('SELECT * FROM sections WHERE menu_id = ? ORDER BY position'),
    items: db.prepare(`
      SELECT i.* FROM items i JOIN sections s ON s.id = i.section_id
      WHERE s.menu_id = ? ORDER BY i.position`),
    deleteSections: db.prepare('DELETE FROM sections WHERE menu_id = ?'),
    insertSection: db.prepare(
      'INSERT INTO sections (menu_id, position, name, description) VALUES (?, ?, ?, ?)'),
    insertItem: db.prepare(`
      INSERT INTO items (section_id, position, name, description, price, tags, available)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
  };

  function uniqueCode() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = generateCode();
      if (!stmts.codeExists.get(code)) return code;
    }
    throw new Error('Could not generate a unique menu code');
  }

  // Timestamps double as the optimistic-locking version for the editor, so
  // they must change on every save even when two saves land in the same ms.
  function nextTimestamp(previous) {
    let ts = now();
    if (previous && ts <= previous) ts = new Date(Date.parse(previous) + 1).toISOString();
    return ts;
  }

  function writeSections(menuId, sections) {
    stmts.deleteSections.run(menuId);
    sections.forEach((section, sIndex) => {
      const { lastInsertRowid: sectionId } = stmts.insertSection.run(
        menuId, sIndex, section.name, section.description);
      section.items.forEach((item, iIndex) => {
        stmts.insertItem.run(sectionId, iIndex, item.name, item.description, item.price,
          item.tags.join(', '), item.available ? 1 : 0);
      });
    });
  }

  function getMenu(row) {
    if (!row) return null;
    const menu = rowToMenu(row);
    const sections = stmts.sections.all(menu.id).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      items: [],
    }));
    const byId = new Map(sections.map((s) => [s.id, s]));
    for (const i of stmts.items.all(menu.id)) {
      byId.get(i.section_id).items.push({
        name: i.name,
        description: i.description,
        price: i.price,
        tags: i.tags ? i.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
        available: i.available === 1,
      });
    }
    menu.sections = sections.map(({ id, ...rest }) => rest);
    return menu;
  }

  return {
    listMenus() {
      return stmts.list.all().map((row) => ({
        ...rowToMenu(row),
        sectionCount: row.section_count,
        itemCount: row.item_count,
      }));
    },

    getMenuById(id) {
      return getMenu(stmts.byId.get(id));
    },

    getMenuByCode(code) {
      return getMenu(stmts.byCode.get(code));
    },

    /** @param {{title, description?, currency?, published?, sections?}} data — already validated */
    createMenu(data) {
      return transaction(db, () => {
        const ts = now();
        const { lastInsertRowid: id } = stmts.insertMenu.run(
          uniqueCode(), data.title, data.description ?? '', data.currency ?? '$',
          data.published === false ? 0 : 1, ts, ts);
        if (data.sections) writeSections(id, data.sections);
        return getMenu(stmts.byId.get(id));
      });
    },

    /**
     * Replaces a menu's details and full content. If expectedUpdatedAt is
     * given and doesn't match, nothing is written and { conflict: true } is
     * returned so the editor can tell the admin someone else saved first.
     */
    saveMenu(id, data, expectedUpdatedAt) {
      return transaction(db, () => {
        const row = stmts.byId.get(id);
        if (!row) return { notFound: true };
        if (expectedUpdatedAt && expectedUpdatedAt !== row.updated_at) {
          return { conflict: true, menu: getMenu(row) };
        }
        stmts.updateMenu.run(data.title, data.description, data.currency,
          data.published ? 1 : 0, nextTimestamp(row.updated_at), id);
        writeSections(id, data.sections);
        return { menu: getMenu(stmts.byId.get(id)) };
      });
    },

    deleteMenu(id) {
      return stmts.deleteMenu.run(id).changes > 0;
    },

    close() {
      db.close();
    },
  };
}

module.exports = { openDatabase, generateCode };
