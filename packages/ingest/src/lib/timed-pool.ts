import type pg from "pg";
import { recordMetric } from "./observability.js";

const SLOW_QUERY_THRESHOLD_MS = 500;

/**
 * Extract a short label from a SQL query for metric cardinality control.
 * Returns the first SQL keyword + table name, e.g. "SELECT traces", "INSERT tenants".
 */
function extractQueryLabel(sql: string): string {
  const trimmed = sql.trim().replace(/\s+/g, " ");

  // SELECT ... FROM table
  const selectMatch = trimmed.match(/^SELECT\s+.+?\s+FROM\s+(?:public\.)?(?:"[^"]*"\.)?"?(\w+)"?/i);
  if (selectMatch) {
    return `SELECT ${selectMatch[1].toLowerCase()}`;
  }

  // INSERT INTO table
  const insertMatch = trimmed.match(/^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:public\.)?(?:"[^"]*"\.)?"?(\w+)"?/i);
  if (insertMatch) {
    return `INSERT ${insertMatch[1].toLowerCase()}`;
  }

  // UPDATE table
  const updateMatch = trimmed.match(/^UPDATE\s+(?:public\.)?(?:"[^"]*"\.)?"?(\w+)"?/i);
  if (updateMatch) {
    return `UPDATE ${updateMatch[1].toLowerCase()}`;
  }

  // DELETE FROM table
  const deleteMatch = trimmed.match(/^DELETE\s+FROM\s+(?:public\.)?(?:"[^"]*"\.)?"?(\w+)"?/i);
  if (deleteMatch) {
    return `DELETE ${deleteMatch[1].toLowerCase()}`;
  }

  // CREATE TABLE [IF NOT EXISTS] table
  const createMatch = trimmed.match(/^CREATE\s+(?:TABLE|INDEX|SCHEMA)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:public\.)?(?:"[^"]*"\.)?"?(\w+)"?/i);
  if (createMatch) {
    return `CREATE ${createMatch[1].toLowerCase()}`;
  }

  // DROP TABLE/SCHEMA
  const dropMatch = trimmed.match(/^DROP\s+(?:TABLE|INDEX|SCHEMA)\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(?:"[^"]*"\.)?"?(\w+)"?/i);
  if (dropMatch) {
    return `DROP ${dropMatch[1].toLowerCase()}`;
  }

  // Fallback: just the verb
  const verb = trimmed.split(/\s/)[0].toUpperCase();
  return verb.length <= 10 ? verb : "QUERY";
}

/**
 * Wrap a pg.Pool to instrument all queries with timing metrics.
 *
 * Every `pool.query()` call records:
 * - `db.query_ms` gauge with labels { operation }
 * - Console warning for queries exceeding 500ms
 *
 * The wrapper is transparent — it returns the same Pool interface
 * so all existing code works unchanged.
 */
export function instrumentPool(pool: pg.Pool): pg.Pool {
  const originalQuery = pool.query.bind(pool);

  // Override pool.query with a timed version
  // pg.Pool.query has multiple overloads — we use a generic wrapper
  pool.query = (async (...args: unknown[]) => {
    const start = performance.now();
    try {
      const result = await (originalQuery as (...a: unknown[]) => Promise<unknown>)(...args);
      return result;
    } finally {
      const durationMs = Math.round(performance.now() - start);
      const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
      const operation = extractQueryLabel(sql);

      recordMetric("db.query_ms", durationMs, { operation });

      if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
        console.warn(
          `[db] Slow query (${durationMs}ms): ${operation} — ${sql.slice(0, 120).replace(/\s+/g, " ")}`,
        );
      }
    }
  }) as typeof pool.query;

  return pool;
}
