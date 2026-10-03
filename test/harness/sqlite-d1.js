// A D1 stand-in on a real SQLite engine, so a test runs the worker's actual SQL (an upsert with
// a WHERE guard, a prune with LIMIT and OFFSET) rather than an imitation of it. D1 is SQLite,
// and `meta.changes` is what SQLite reports for the statement.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = ['0001_initial.sql', '0002_kademlia_overlay.sql'];

/** The table a write statement names, or null for a read. */
function writtenTable(sql) {
  return /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+(\w+)/i.exec(sql)?.[1] ?? null;
}

/** An in-memory D1 with every migration applied, or null when this Node has no node:sqlite. */
export async function openSqliteD1() {
  const sqlite = await import('node:sqlite').catch(() => null);
  if (!sqlite) return null;
  const db = new sqlite.DatabaseSync(':memory:');
  for (const file of MIGRATIONS) {
    db.exec(readFileSync(fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url)), 'utf8'));
  }
  // Rows actually changed, by table, across every statement run so far.
  const writes = {};
  return {
    writes,
    raw: db,
    prepare(sql) {
      const statement = db.prepare(sql);
      const table = writtenTable(sql);
      return {
        bind(...values) {
          return {
            async run() {
              const result = statement.run(...values);
              if (table) writes[table] = (writes[table] ?? 0) + Number(result.changes);
              return { success: true, meta: { changes: Number(result.changes) } };
            },
            async all() {
              return { results: statement.all(...values) };
            },
            async first() {
              return statement.get(...values) ?? null;
            },
          };
        },
      };
    },
  };
}
