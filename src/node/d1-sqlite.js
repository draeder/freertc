// D1 on a local SQLite file, so a relay running under Node executes the same
// SQL the Cloudflare worker does. D1 is SQLite; this is the subset of its
// binding the relay uses: prepare(sql).bind(...).all() / .run() / .first().
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS_TABLE = 'freertc_node_migrations';

function statementApi(statement, values = []) {
  return {
    bind: (...next) => statementApi(statement, next),
    async all() {
      return { success: true, results: statement.all(...values) };
    },
    async run() {
      const result = statement.run(...values);
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    },
    async first(column) {
      const row = statement.get(...values);
      if (!row) return null;
      return column ? row[column] : row;
    },
  };
}

/**
 * Open (creating if needed) a SQLite database at `filename` and apply every
 * migration in `migrationsDir` that has not been applied to it yet.
 */
export async function openSqliteD1({ filename, migrationsDir }) {
  const { DatabaseSync } = await import('node:sqlite');
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all().map((row) => row.name));
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  for (const name of files) {
    if (applied.has(name)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(path.join(migrationsDir, name), 'utf8'));
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`).run(name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${error.message}`);
    }
  }
  const statements = new Map();
  return {
    raw: db,
    prepare(sql) {
      let statement = statements.get(sql);
      if (!statement) {
        statement = db.prepare(sql);
        statements.set(sql, statement);
      }
      return statementApi(statement);
    },
    async batch(prepared) {
      const results = [];
      for (const item of prepared) results.push(await item.run());
      return results;
    },
    close() {
      db.close();
    },
  };
}
