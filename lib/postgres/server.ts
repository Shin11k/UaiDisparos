import { getCloudflareContext } from "@opennextjs/cloudflare";
import { Client, type QueryResultRow } from "pg";

type CloudflareDatabaseEnv = {
  HYPERDRIVE?: { connectionString: string };
};

/**
 * Cloudflare Workers -> Hyperdrive -> Workers VPC -> Cloudflare Tunnel -> PostgreSQL.
 * The underlying PostgreSQL credentials never belong in browser JavaScript.
 */
export function getDatabaseUrl(): string {
  let env: CloudflareDatabaseEnv;
  try {
    env = getCloudflareContext().env as CloudflareDatabaseEnv;
  } catch {
    // Local-only development with DATABASE_URL; never expose on the client.
    const local = process.env.DATABASE_URL;
    if (local) return local;
    throw new Error("HYPERDRIVE binding não disponível no Worker.");
  }

  const url = env.HYPERDRIVE?.connectionString;
  if (!url) {
    throw new Error("HYPERDRIVE não está configurado no Worker.");
  }
  return url;
}

/** Execute a parameterized SQL query against the configured PostgreSQL backend. */
export async function queryPostgres<T extends QueryResultRow = QueryResultRow>(
  statement: string,
  values: readonly unknown[] = [],
) {
  const client = new Client({
    connectionString: getDatabaseUrl(),
    connectionTimeoutMillis: 8_000,
    query_timeout: 10_000,
    application_name: "uaidisparos",
  });
  await client.connect();
  try {
    return await client.query<T>(statement, [...values]);
  } finally {
    await client.end();
  }
}

/** Transaction for user/account creation and other atomic multi-table operations. */
export async function withPostgresTransaction<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: getDatabaseUrl(),
    connectionTimeoutMillis: 8_000,
    query_timeout: 12_000,
    application_name: "uaidisparos-transaction",
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    await client.end();
  }
}
