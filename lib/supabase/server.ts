// Transitional compatibility name for trusted background/server flows.
// Uses PostgreSQL Hyperdrive; never bypass this elevated client in user routes.
import { getPostgresAdminClient } from "@/lib/postgres/compat";

export function getSupabaseAdmin(): any {
  return getPostgresAdminClient();
}
