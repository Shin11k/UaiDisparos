import { getCloudflareContext } from "@opennextjs/cloudflare";
import { Client, type QueryResultRow, type QueryResult } from "pg";

type CloudflareDatabaseEnv = {
  HYPERDRIVE?: { connectionString: string };
  UAI_SQL_GATEWAY?: { fetch(input: string, init?: RequestInit): Promise<Response> };
  UAI_GATEWAY_TOKEN?: string;
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
  // Preferred path for a Windows PostgreSQL server with SSL disabled:
  // Worker -> Workers VPC (encrypted tunnel) -> localhost-only HTTP gateway -> PostgreSQL.
  // The PostgreSQL password never leaves the Windows server.
  let remote: CloudflareDatabaseEnv | null = null;
  try { remote = getCloudflareContext().env as CloudflareDatabaseEnv; } catch {}
  if (remote?.UAI_SQL_GATEWAY) {
    const token = remote.UAI_GATEWAY_TOKEN;
    if (!token || token.length < 32) throw new Error("Segredo do gateway UAI não configurado.");
    const response = await remote.UAI_SQL_GATEWAY.fetch("http://127.0.0.1:3107/sql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ sql: statement, values }),
    });
    const body = await response.json() as { ok?: boolean; rows?: T[]; rowCount?: number; error?: string; code?: string };
    if (!response.ok || !body.ok) {
      const error = new Error(body.error || "Gateway PostgreSQL indisponível.") as Error & { code?: string };
      error.code = body.code;
      throw error;
    }
    return { rows: body.rows || [], rowCount: body.rowCount ?? 0 } as QueryResult<T>;
  }
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
