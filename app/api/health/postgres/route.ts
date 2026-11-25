import { NextResponse } from "next/server";
import { queryPostgres } from "@/lib/postgres/server";

export const dynamic = "force-dynamic";

/**
 * Temporary staging probe. Does not read or expose private business records.
 * Never use this endpoint as proof that the app auth and campaign flow are migrated.
 */
export async function GET() {
  try {
    const result = await queryPostgres<{ ready: number }>(
      "select 1::int as ready",
    );
    return NextResponse.json(
      { ok: result.rows[0]?.ready === 1, database: "postgresql", stage: "connectivity-only" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { ok: false, database: "postgresql", stage: "connectivity-only" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
