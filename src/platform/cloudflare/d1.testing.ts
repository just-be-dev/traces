import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import type { D1Bound, D1Statements } from "./traces.ts";

const migrations = new URL("../../../migrations/", import.meta.url);

/**
 * D1 is SQLite, so tests run the real migrations and adapter SQL against bun:sqlite.
 * This checks SQL, migration syntax, and batch atomicity, not D1's network or
 * consistency behavior.
 */
export const sqliteD1 = async () => {
  const db = new Database(":memory:");
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    db.exec(await Bun.file(new URL(file, migrations)).text());
  const bound = new WeakMap<D1Bound, { sql: string; values: Array<unknown> }>();
  const run = (sql: string, values: Array<unknown>) => ({
    meta: { changes: db.query(sql).run(...(values as [])).changes },
  });
  const d1: D1Statements = {
    prepare: (sql) => ({
      bind: (...values) => {
        const statement: D1Bound = {
          run: async () => run(sql, values),
          all: async () => ({ results: db.query(sql).all(...(values as [])) }),
        };
        bound.set(statement, { sql, values });
        return statement;
      },
    }),
    batch: async (statements) =>
      db.transaction(() =>
        statements.map((statement) => {
          const found = bound.get(statement);
          if (!found) throw new Error("Statement was not prepared by this database");
          return run(found.sql, found.values);
        }),
      )(),
  };
  return { db, d1 };
};
