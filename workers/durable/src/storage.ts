/**
 * The slice of Durable Object storage the object logic uses. In production
 * this is `ctx.storage`; tests back it with node:sqlite.
 */
export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

export interface Sql {
  exec<T = Row>(query: string, ...bindings: SqlValue[]): { toArray(): T[]; readonly rowsWritten: number };
}

export interface Storage {
  sql: Sql;
  transactionSync<T>(fn: () => T): T;
}

export function fromDurableStorage(storage: DurableObjectStorage): Storage {
  return {
    sql: {
      exec<T = Row>(query: string, ...bindings: SqlValue[]) {
        const cursor = storage.sql.exec(query, ...bindings);
        return {
          toArray: () => cursor.toArray() as T[],
          get rowsWritten() {
            return cursor.rowsWritten;
          },
        };
      },
    },
    transactionSync: (fn) => storage.transactionSync(fn),
  };
}

/** Apply numbered migrations once, tracked in a meta table. */
export function migrate(storage: Storage, migrations: readonly string[]): void {
  const { sql } = storage;
  sql.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version'").toArray()[0];
  const current = row ? Number(row.value) : 0;
  if (current >= migrations.length) return;
  storage.transactionSync(() => {
    for (let i = current; i < migrations.length; i++) sql.exec(migrations[i]!);
    sql.exec(
      "INSERT INTO _meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      String(migrations.length),
    );
  });
}

/** Token bucket. Kept in memory or in a socket attachment; resets are harmless. */
export interface Bucket {
  tokens: number;
  at: number;
}

export function takeToken(
  bucket: Bucket | undefined,
  burst: number,
  perSecond: number,
  now: number,
): { allowed: boolean; bucket: Bucket } {
  const prev = bucket ?? { tokens: burst, at: now };
  const tokens = Math.min(burst, prev.tokens + ((now - prev.at) / 1000) * perSecond);
  if (tokens < 1) return { allowed: false, bucket: { tokens, at: now } };
  return { allowed: true, bucket: { tokens: tokens - 1, at: now } };
}
