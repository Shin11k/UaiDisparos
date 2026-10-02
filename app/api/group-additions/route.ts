import { NextRequest, NextResponse } from "next/server";
import { getSupabaseSession } from "@/lib/supabase/session";
import { getTenantContext } from "@/lib/tenant";
import {
  buildGroupAdditionSchedule,
  normalizeGroupAdditionPhone,
  validateInstanceGroupAdmin,
  type GroupAdditionLead,
  type GroupAdditionInstance,
} from "@/lib/groupAdditions";

export const dynamic = "force-dynamic";

function summarizeCampaigns(campaigns: any[], jobs: any[]) {
  const jobsByCampaign = new Map<string, any[]>();
  for (const job of jobs || []) {
    const list = jobsByCampaign.get(job.campaign_id) || [];
    list.push(job);
    jobsByCampaign.set(job.campaign_id, list);
  }

  return (campaigns || []).map((campaign) => {
    const rows = jobsByCampaign.get(campaign.id) || [];
    const counts: Record<string, number> = {
      queued: 0,
      processing: 0,
      added: 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
    };

    for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;

    const next = rows
      .filter((row) => row.status === "queued")
      .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))[0] || null;

    const lastErrors = rows
      .filter((row) => row.error_message)
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      .slice(0, 5)
      .map((row) => ({
        id: row.id,
        phone: row.phone,
        lead_name: row.lead_name,
        error_message: row.error_message,
        updated_at: row.updated_at,
      }));

    const senderUsage = new Map<string, number>();
    for (const row of rows) {
      if (row.status !== "added") continue;
      senderUsage.set(row.instance_id, (senderUsage.get(row.instance_id) || 0) + 1);
    }

    return {
      ...campaign,
      counts,
      next_job: next ? {
        id: next.id,
        phone: next.phone,
        lead_name: next.lead_name,
        instance_id: next.instance_id,
        scheduled_at: next.scheduled_at,
      } : null,
      sender_usage_total: Object.fromEntries(senderUsage),
      last_errors: lastErrors,
    };
  });
}

export async function GET(req: NextRequest) {
  try {
    const { accountId } = getTenantContext();
    const supabase = getSupabaseSession();
    const selectedId = req.nextUrl.searchParams.get("id");

    let campaignsQuery = supabase
      .from("group_addition_campaigns")
      .select("*")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (selectedId) campaignsQuery = campaignsQuery.eq("id", selectedId);

    const { data: campaigns, error: campaignsError } = await campaignsQuery;
    if (campaignsError) throw campaignsError;

    const ids = (campaigns || []).map((item) => item.id);
    let jobs: any[] = [];

    if (ids.length) {
      const { data, error } = await supabase
        .from("group_addition_jobs")
        .select("id,campaign_id,instance_id,phone,lead_name,scheduled_at,status,error_message,processed_at,updated_at")
        .eq("account_id", accountId)
        .in("campaign_id", ids)
        .order("sequence", { ascending: true });

      if (error) throw error;
      jobs = data || [];
    }

    const { data: instances } = await supabase
      .from("instances")
      .select("id,name,phone,status")
      .eq("account_id", accountId);

    return NextResponse.json({
      ok: true,
      campaigns: summarizeCampaigns(campaigns || [], jobs),
      instances: instances || [],
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Erro ao carregar adições em grupos." },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const context = getTenantContext();
    const accountId = context.accountId;
    const userId = context.userId;
    const body = await req.json().catch(() => ({}));

    if (body?.authorization_confirmed !== true) {
      return NextResponse.json(
        { ok: false, error: "Confirme que os contatos autorizaram a inclusão no grupo." },
        { status: 400 },
      );
    }

    const name = String(body?.name || "Adicionar em grupo").trim().slice(0, 100);
    const groupId = String(body?.group_id || "");
    const senderIds: string[] = Array.from(new Set<string>(
      Array.isArray(body?.sender_instance_ids)
        ? body.sender_instance_ids.map((value: unknown) => String(value || "")).filter(Boolean)
        : [],
    ));

    const dailyLimit = Math.min(15, Math.max(1, Math.round(Number(body?.daily_limit_per_sender || 15))));
    const intervalMinutes = Math.min(60, Math.max(1, Math.round(Number(body?.interval_minutes || 3))));
    const workStartHour = Math.min(22, Math.max(0, Math.round(Number(body?.work_start_hour ?? 8))));
    const workEndHour = Math.min(23, Math.max(workStartHour + 1, Math.round(Number(body?.work_end_hour ?? 22))));

    if (!groupId) {
      return NextResponse.json({ ok: false, error: "Escolha um grupo." }, { status: 400 });
    }
    if (!senderIds.length) {
      return NextResponse.json({ ok: false, error: "Escolha pelo menos uma conexão." }, { status: 400 });
    }

    const rawLeads = Array.isArray(body?.leads) ? body.leads : [];
    const unique = new Map<string, GroupAdditionLead>();

    for (const item of rawLeads) {
      const phone = normalizeGroupAdditionPhone(item?.phone ?? item);
      if (!phone) continue;
      if (!unique.has(phone)) {
        unique.set(phone, {
          phone,
          name: typeof item?.name === "string" ? item.name.trim().slice(0, 120) : null,
        });
      }
    }

    const leads = Array.from(unique.values()).slice(0, 5000);
    if (!leads.length) {
      return NextResponse.json(
        { ok: false, error: "A lista não possui números válidos. Use DDI + DDD + número." },
        { status: 400 },
      );
    }

    const supabase = getSupabaseSession();

    const [{ data: group, error: groupError }, { data: senders, error: sendersError }] = await Promise.all([
      supabase
        .from("groups")
        .select("id,name,external_id")
        .eq("id", groupId)
        .eq("account_id", accountId)
        .maybeSingle(),
      supabase
        .from("instances")
        .select("id,name,phone,status,base_url,api_token")
        .eq("account_id", accountId)
        .in("id", senderIds),
    ]);

    if (groupError) throw groupError;
    if (!group) {
      return NextResponse.json({ ok: false, error: "Grupo não encontrado nesta operação." }, { status: 404 });
    }
    if (sendersError) throw sendersError;
    if (!senders || senders.length !== senderIds.length) {
      return NextResponse.json({ ok: false, error: "Uma ou mais conexões não pertencem a esta operação." }, { status: 400 });
    }

    const validation: Array<{ id: string; name: string; phone: string | null; ok: boolean; reason: string }> = [];
    for (const sender of senders as GroupAdditionInstance[]) {
      const result = await validateInstanceGroupAdmin(sender, group.external_id);
      validation.push({ id: sender.id, name: sender.name, phone: sender.phone, ...result });
    }

    const invalid = validation.filter((item) => !item.ok);
    if (invalid.length) {
      return NextResponse.json({
        ok: false,
        error: "Todas as conexões escolhidas precisam estar conectadas e ser administradoras do grupo.",
        validation,
      }, { status: 400 });
    }

    const { data: existingReservations, error: reservationsError } = await supabase
      .from("group_addition_jobs")
      .select("instance_id,status,scheduled_at,processed_at")
      .eq("account_id", accountId)
      .in("instance_id", senderIds)
      .in("status", ["queued", "processing", "added"])
      .gte("scheduled_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    if (reservationsError) throw reservationsError;

    const schedule = buildGroupAdditionSchedule({
      leads,
      senderIds,
      existingReservations: existingReservations || [],
      dailyLimit,
      intervalMinutes,
      workStartHour,
      workEndHour,
      startAt: new Date(Date.now() + 60_000),
    });

    const { data: campaign, error: campaignError } = await supabase
      .from("group_addition_campaigns")
      .insert({
        account_id: accountId,
        name,
        group_id: group.id,
        group_external_id: group.external_id,
        group_name: group.name || group.external_id,
        sender_instance_ids: senderIds,
        status: "active",
        authorization_confirmed: true,
        total_leads: leads.length,
        daily_limit_per_sender: dailyLimit,
        interval_minutes: intervalMinutes,
        work_start_hour: workStartHour,
        work_end_hour: workEndHour,
        starts_at: schedule.jobs[0]?.scheduledAt || new Date().toISOString(),
        estimated_finish_at: schedule.estimatedFinishAt,
        created_by: userId,
        updated_at: new Date().toISOString(),
      })
      .select("*")
      .single();

    if (campaignError) throw campaignError;

    const rows = schedule.jobs.map((job) => ({
      account_id: accountId,
      campaign_id: campaign.id,
      instance_id: job.instanceId,
      group_id: group.id,
      phone: job.phone,
      lead_name: job.leadName,
      sequence: job.sequence,
      scheduled_at: job.scheduledAt,
      status: "queued",
      updated_at: new Date().toISOString(),
    }));

    const { error: jobsError } = await supabase.from("group_addition_jobs").insert(rows);
    if (jobsError) {
      await supabase.from("group_addition_campaigns").delete().eq("id", campaign.id).eq("account_id", accountId);
      throw jobsError;
    }

    return NextResponse.json({
      ok: true,
      campaign,
      validation,
      planned_by_day: schedule.plannedByDay,
      total: leads.length,
      estimated_finish_at: schedule.estimatedFinishAt,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Erro ao criar fila de adição." },
      { status: 500 },
    );
  }
}
