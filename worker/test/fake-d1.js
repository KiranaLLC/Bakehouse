/*
  A stand-in for Cloudflare D1 in tests: an in-memory SQLite database (Node's
  built-in node:sqlite) with the real schema.sql applied, behind the small
  part of the D1 API the workers use: prepare().bind().all() / first() / run().
*/

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function createFakeD1() {

  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));

  return {
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...values) { params = values; return statement; },
        async all() { return { results: db.prepare(sql).all(...params).map(row => ({ ...row })) }; },
        async first() { const row = db.prepare(sql).get(...params); return row ? { ...row } : null; },
        async run() { const result = db.prepare(sql).run(...params); return { success: true, meta: { changes: Number(result.changes) } }; }
      };
      return statement;
    }
  };

}
