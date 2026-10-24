/**
 * Database access: hand-written SQL through a parameterised `sql` tag.
 *
 * Neon (production, `@neondatabase/serverless` Pool over WebSockets) and node-postgres (local and CI) share the
 * same Pool API, so every query and transaction runs unchanged on both.
 */
import { neonConfig, Pool as NeonPool, types as neonTypes } from "@neondatabase/serverless";
import pg from "pg";

// int8 → number (amounts and sizes stay well below 2^53).
pg.types.setTypeParser(20, (v) => Number(v));
neonTypes.setTypeParser(20, (v: string) => Number(v));
neonConfig.poolQueryViaFetch = false;

export class SqlQuery {
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly unknown[],
  ) {}

  /** Flattens nested fragments into `$1, $2…` placeholders. */
  build(): { text: string; values: unknown[] } {
    const values: unknown[] = [];
    const walk = (q: SqlQuery): string => {
      let text = q.strings[0];
      q.values.forEach((value, i) => {
        if (value instanceof SqlQuery) text += walk(value);
        else if (value instanceof Raw) text += value.text;
        else {
          values.push(value instanceof Json ? JSON.stringify(value.value) : value);
          text += `$${values.length}`;
        }
        text += q.strings[i + 1];
      });
      return text;
    };
    return { text: walk(this), values };
  }
}

class Json {
  constructor(readonly value: unknown) {}
}
class Raw {
  constructor(readonly text: string) {}
}

export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery {
  return new SqlQuery(strings, values);
}
/** A jsonb parameter (plain JS arrays would otherwise become Postgres arrays). */
sql.json = (value: unknown) => new Json(value);
/** Trusted SQL text (identifiers from code, never user input). */
sql.raw = (text: string) => new Raw(text);
sql.join = (parts: SqlQuery[], separator = ", "): SqlQuery => {
  if (parts.length === 0) return sql``;
  const strings = ["", ...parts.slice(1).map(() => separator), ""];
  return new SqlQuery(strings, parts);
};
sql.empty = () => sql``;

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export class Db {
  constructor(private readonly client: Queryable) {}

  async query<T = Record<string, unknown>>(q: SqlQuery): Promise<T[]> {
    const { text, values } = q.build();
    const result = await this.client.query(text, values);
    return result.rows as T[];
  }

  async one<T = Record<string, unknown>>(q: SqlQuery): Promise<T> {
    const rows = await this.query<T>(q);
    if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`);
    return rows[0];
  }

  async maybeOne<T = Record<string, unknown>>(q: SqlQuery): Promise<T | null> {
    const rows = await this.query<T>(q);
    return rows[0] ?? null;
  }

  async exec(q: SqlQuery): Promise<number> {
    const { text, values } = q.build();
    const result = await this.client.query(text, values);
    return result.rowCount ?? 0;
  }

  /** Runs a raw multi-statement script (migrations only). */
  async script(text: string): Promise<void> {
    await this.client.query(text);
  }

  /**
   * Inserts many rows in one statement through jsonb_to_recordset; returns the inserted rows.
   * `columns` maps each column to its SQL type, e.g. { id: "uuid", value: "double precision", locator: "jsonb" }.
   */
  async insertMany<T = Record<string, unknown>>(
    table: string,
    columns: Record<string, string>,
    rows: Record<string, unknown>[],
    returning = "*",
  ): Promise<T[]> {
    if (rows.length === 0) return [];
    const names = Object.keys(columns);
    const cols = names.map((c) => `"${c}"`).join(", ");
    const defs = names.map((c) => `"${c}" ${columns[c]}`).join(", ");
    const out: T[] = [];
    for (let i = 0; i < rows.length; i += 2000) {
      const batch = rows.slice(i, i + 2000).map((r) => Object.fromEntries(names.map((c) => [c, r[c] ?? null])));
      const text = `INSERT INTO ${table} (${cols}) SELECT ${cols} FROM jsonb_to_recordset($1::jsonb) AS r(${defs}) RETURNING ${returning}`;
      const result = await this.client.query(text, [JSON.stringify(batch)]);
      out.push(...(result.rows as T[]));
    }
    return out;
  }
}

type AnyPool = { query: Queryable["query"]; connect(): Promise<PoolClientLike>; end(): Promise<void> };
type PoolClientLike = Queryable & { release(): void };

let pool: AnyPool | null = null;
let poolUrl: string | null = null;

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgresql://auditflow:auditflow@localhost:5432/auditflow";
}

function isNeon(url: string): boolean {
  return /\.neon\.tech|neon\.build/.test(url) || process.env.AUDITFLOW_DB_DRIVER === "neon";
}

export function getPool(): AnyPool {
  const url = databaseUrl();
  if (!pool || poolUrl !== url) {
    pool = (isNeon(url) ? new NeonPool({ connectionString: url }) : new pg.Pool({ connectionString: url, max: 10 })) as unknown as AnyPool;
    poolUrl = url;
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
  poolUrl = null;
}

/** Shared connection-pool handle. */
export const db = new Proxy({} as Db, {
  get(_target, prop) {
    const instance = new Db(getPool());
    const value = (instance as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(instance) : value;
  },
});

export async function transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(new Db(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
