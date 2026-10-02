import { NextRequest, NextResponse } from "next/server";
import { getSupabaseSession } from "@/lib/supabase/session";
import { getTenantContext } from "@/lib/tenant";
import { buildGroupAdditionSchedule } from "@/lib/groupAdditions";

export const dynamic = "force-dynamic";

async function updateInChunks<T>(items: T[], worker: (item: T, index: number) => Promise<unknown>, size = 40) {
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    await Promise.all(chunk.map((item, offset) => worker(item, i + offset)));
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { accountId } = getTenantContext();
    const id = String(params.id || "");
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "");
    const supabase = getSupabaseSession();

    const { data: campaign, error: campaignError } = await supabase
      .from("group_addition_campaigns")
      .select("*")
      .eq("id", id)
      .eq("account_id", accountId)
      .maybeSingle();

    if (campaignError) throw campaignError;
    if (!campaign) {
      return NextResponse.json({ ok: false, error: "Fila não encontrada." }, { status: 404 });
    }

    if (action === "pause") {
      if (campaign.status === "completed" || campaign.status === "cancelled") {
        return NextResponse.json({ ok: false, error: "Essa fila já foi encerrada." }, { status: 400 });
      }

      const { error } = await supabase
        .from("group_addition_campaigns")
        .update({ status: "paused", updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("account_id", accountId);
      if (error) throw error;

      return NextResponse.json({ ok: true, status: "paused" });
    }

    if (action === "cancel") {
      if (campaign.status === "completed") {
        return NextResponse.json({ ok: false, error: "Essa fila já foi concluída." }, { status: 400 });
      }

      const now = new Date().toISOString();
      const [{ error: campaignUpdateError }, { error: jobsUpdateError }] = await Promise.all([
        supabase
          .from("group_addition_campaigns")
          .update({ status: "cancelled", completed_at: now, updated_at: now })
          .eq("id", id)
          .eq("account_id", accountId),
        supabase
          .from("group_addition_jobs")
          .update({ status: "cancelled", processed_at: now, updated_at: now })
          .eq("campaign_id", id)
          .eq("account_id", accountId)
          .in("status", ["queued", "processing"]),
      ]);

      if (campaignUpdateError) throw campaignUpdateError;
      if (jobsUpdateError) throw jobsUpdateError;

      return NextResponse.json({ ok: true, status: "cancelled" });
    }

    if (action === "resume") {
      if (campaign.status !== "paused") {
        return NextResponse.json({ ok: false, error: "A fila precisa estar pausada para continuar." }, { status: 400 });
      }

      const { data: queued, error: queuedError } = await supabase
        .from("group_addition_jobs")
        .select("id,phone,lead_name,sequence")
        .eq("account_id", accountId)
        .eq("campaign_id", id)
        .eq("status", "queued")
        .order("sequence", { ascending: true });

      if (queuedError) throw queuedError;

      const senderIds = Array.isArray(campaign.sender_instance_ids)
        ? campaign.sender_instance_ids.map(String)
        : [];

      if (!senderIds.length) {
        return NextResponse.json({ ok: false, error: "Essa fila não possui conexões configuradas." }, { status: 400 });
      }

      const { data: existingReservations, error: reservationsError } = await supabase
        .from("group_addition_jobs")
        .select("instance_id,status,scheduled_at,processed_at")
        .eq("account_id", accountId)
        .in("instance_id", senderIds)
        .neq("campaign_id", id)
        .in("status", ["queued", "processing", "added"])
        .gte("scheduled_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

      if (reservationsError) throw reservationsError;

      const schedule = buildGroupAdditionSchedule({
        leads: (queued || []).map((row) => ({ phone: row.phone, name: row.lead_name })),
        senderIds,
        existingReservations: existingReservations || [],
        dailyLimit: Number(campaign.daily_limit_per_sender || 15),
        intervalMinutes: Number(campaign.interval_minutes || 3),
        workStartHour: Number(campaign.work_start_hour || 8),
        workEndHour: Number(campaign.work_end_hour || 22),
        startAt: new Date(Date.now() + 60_000),
      });

      await updateInChunks(queued || [], async (row: any, index) => {
        const planned = schedule.jobs[index];
        if (!planned) return;
        const { error } = await supabase
          .from("group_addition_jobs")
          .update({
            instance_id: planned.instanceId,
            scheduled_at: planned.scheduledAt,
            error_message: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id)
          .eq("account_id", accountId)
          .eq("status", "queued");
        if (error) throw error;
      });

      const { error: resumeError } = await supabase
        .from("group_addition_campaigns")
        .update({
          status: "active",
          starts_at: schedule.jobs[0]?.scheduledAt || new Date().toISOString(),
          estimated_finish_at: schedule.estimatedFinishAt,
          completed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("account_id", accountId);

      if (resumeError) throw resumeError;

      return NextResponse.json({
        ok: true,
        status: "active",
        estimated_finish_at: schedule.estimatedFinishAt,
        planned_by_day: schedule.plannedByDay,
      });
    }

    return NextResponse.json({ ok: false, error: "Ação inválida." }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Erro ao alterar fila." },
      { status: 500 },
    );
  }
}
