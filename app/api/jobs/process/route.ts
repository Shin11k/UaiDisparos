import { NextResponse } from "next/server";
import { authorizedQueueRequest } from "@/lib/auth/queue";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { processJob } from "@/lib/automation";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!authorizedQueueRequest(request)) return NextResponse.json({ ok: false, error: "Não autorizado." }, { status: 401 });
  try {
    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();
    const { data: jobs, error } = await supabase
      .from("jobs")
      .select("id")
      .eq("status", "queued")
      .or(`scheduled_at.is.null,scheduled_at.lte.${now}`)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) throw error;

    const results = [];
    for (const job of jobs ?? []) {
      try {
        results.push({ id: job.id, result: await processJob(job.id) });
      } catch (error) {
        results.push({ id: job.id, result: { ok: false, error: error instanceof Error ? error.message : "Erro" } });
      }
    }

    return NextResponse.json({ ok: true, processed: results.length, results });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Erro ao processar fila." }, { status: 500 });
  }
}
