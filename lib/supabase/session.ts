// Transitional compatibility name. All database calls now target local PostgreSQL
// through Cloudflare Hyperdrive. Remove this file after callers migrate imports.
import { getPostgresSessionClient } from "@/lib/postgres/compat";

export function getSupabaseSession(): any {
  return getPostgresSessionClient();
}
