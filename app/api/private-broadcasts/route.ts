import { NextRequest, NextResponse } from "next/server";
import { getSupabaseSession } from "@/lib/supabase/session";
import { requireTenantId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

function uniqStrings(value: unknown, max: number) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean))).slice(0, max);
}

function normalizePhone(value: unknown) {
  const digits = String(value || "").replace(/\D/g, "");
  return /^55\d{2}9\d{8}$/.test(digits) ? digits : null;
}

export async function POST(req: NextRequest) {
  try {
    const accountId = requireTenantId();
    const body = await req.json();
    const name = String(body?.name || "").trim().slice(0, 100);
    const campaignIds = uniqStrings(body?.campaign_ids, 5);
    const senderIds = uniqStrings(body?.sender_instance_ids, 20);
    const sourceGroupIds = uniqStrings(body?.source_group_ids, 100);
    const imported = uniqStrings(body?.imported_numbers, 10000).map(normalizePhone).filter(Boolean) as string[];
    const startDelaySeconds = Math.max(0, Math.min(86400, Math.round(Number(body?.start_delay_seconds || 0))));
    const sendIntervalSeconds = Math.max(1, Math.min(3600, Math.round(Number(body?.send_interval_seconds || 30))));
    const dailyLimit = Math.max(1, Math.min(1000, Math.round(Number(body?.daily_limit_per_sender || 40))));
    const authorizationConfirmed = body?.authorization_confirmed === true;

    if (!name) return NextResponse.json({ ok: false, error: "Dê um nome para o disparo privado." }, { status: 400 });
    if (!campaignIds.length) return NextResponse.json({ ok: false, error: "Selecione ao menos uma campanha." }, { status: 400 });
    if (!senderIds.length) return NextResponse.json({ ok: false, error: "Selecione ao menos uma conta disparadora." }, { status: 400 });
    if (!authorizationConfirmed) return NextResponse.json({ ok: false, error: "Confirme que os destinatários autorizaram contato privado." }, { status: 400 });

    const supabase = getSupabaseSession();
    const [campaignsResult, sendersResult] = await Promise.all([
      supabase.from("campaigns").select("id,status").eq("account_id", accountId).in("id", campaignIds),
      supabase.from("instances").select("id,instance_role").eq("account_id", accountId).in("id", senderIds),
    ]);
    if ((campaignsResult.data || []).filter((x) => x.status === "active").length !== campaignIds.length) {
      return NextResponse.json({ ok: false, error: "Uma ou mais campanhas não estão ativas." }, { status: 400 });
    }
    if ((sendersResult.data || []).filter((x) => x.instance_role === "sender").length !== senderIds.length) {
      return NextResponse.json({ ok: false, error: "Uma ou mais contas selecionadas não são disparadoras válidas." }, { status: 400 });
    }

    let authorizedLeads: any[] = [];
    if (sourceGroupIds.length) {
      const { data } = await supabase
        .from("leads")
        .select("id,phone,name,group_id")
        .in("group_id", sourceGroupIds)
        .eq("account_id", accountId)
        .in("consent_status", ["opted_in", "manual_authorized"])
        .not("phone", "is", null);
      authorizedLeads = data || [];
    }

    const recipients = new Map<string, any>();
    for (const phone of imported) recipients.set(phone, { phone, name: null, source: "txt_import", source_group_id: null, source_lead_id: null });
    for (const lead of authorizedLeads) {
      const phone = normalizePhone(lead.phone);
      if (!phone) continue;
      if (!recipients.has(phone)) recipients.set(phone, { phone, name: lead.name || null, source: "authorized_lead", source_group_id: lead.group_id, source_lead_id: lead.id });
    }

    const rows = [...recipients.values()];
    if (!rows.length) {
      return NextResponse.json({ ok: false, error: "Nenhum destinatário válido. O TXT deve usar 55 + DDD + 9 + número; grupos só entram com leads opt-in." }, { status: 400 });
    }

    const now = new Date();
    const { data: broadcast, error: broadcastError } = await supabase.from("private_broadcasts").insert({
      account_id: accountId,
      name,
      campaign_ids: campaignIds,
      sender_instance_ids: senderIds,
      source_group_ids: sourceGroupIds,
      start_delay_seconds: startDelaySeconds,
      send_interval_seconds: sendIntervalSeconds,
      daily_limit_per_sender: dailyLimit,
      authorization_confirmed: true,
      status: "active",
      updated_at: now.toISOString(),
    }).select("*").single();
    if (broadcastError) throw broadcastError;

    const recipientRows = rows.map((row, index) => ({
      account_id: accountId,
      broadcast_id: broadcast.id,
      ...row,
      campaign_id: campaignIds[index % campaignIds.length],
      instance_id: senderIds[index % senderIds.length],
      status: "queued",
      scheduled_at: new Date(now.getTime() + startDelaySeconds * 1000 + index * sendIntervalSeconds * 1000).toISOString(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }));

    const { error: recipientsError } = await supabase.from("private_broadcast_recipients").insert(recipientRows);
    if (recipientsError) throw recipientsError;

    return NextResponse.json({ ok: true, broadcast, recipients: recipientRows.length });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Erro ao criar disparo privado." }, { status: 500 });
  }
}
