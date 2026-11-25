import { NextResponse } from "next/server";
import { queryPostgres } from "@/lib/postgres/server";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await queryPostgres<{ accounts: string; profiles: string; leads: string }>(
      `SELECT
         (SELECT COUNT(*) FROM public.accounts)::text AS accounts,
         (SELECT COUNT(*) FROM public.profiles)::text AS profiles,
         (SELECT COUNT(*) FROM public.leads)::text AS leads`,
    );
    const checks = result.rows[0];
    return NextResponse.json({
      ok: true, service: "UaiDisparos", database: "postgresql",
      checks: { connected: true, accounts: Number(checks.accounts),
                profiles: Number(checks.profiles), leads: Number(checks.leads) },
      checkedAt: new Date().toISOString(),
    }, {headers: {"Cache-Control":"no-store"}});
  } catch {
    return NextResponse.json({
      ok: false, service: "UaiDisparos", database: "postgresql",
      checks: { connected: false },
      checkedAt: new Date().toISOString(),
    }, {status:503,headers:{"Cache-Control":"no-store"}});
  }
}
