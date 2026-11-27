import { NextRequest, NextResponse } from "next/server";
import { UazapiProvider } from "@/lib/providers/uazapi";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { enqueueForAutomation } from "@/lib/automation";

export const dynamic = "force-dynamic";

function sanitizePayload(payload: any) {
  if (!payload || typeof payload !== "object") return payload;
  const copy = { ...payload };
  if ("token" in copy) copy.token = "[redacted]";
  if ("apikey" in copy) copy.apikey = "[redacted]";
  return copy;
}

function canonicalIdentity(normalized: any) {
  return normalized.phone || normalized.lid || normalized.participantId || null;
}

function leadDedupeKey(groupExternalId: string, normalized: any) {
  const identity = canonicalIdentity(normalized);
  return identity ? `${groupExternalId}|${identity}` : null;
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "uaidisparos-uazapi-webhook",
    timestamp: new Date().toISOString(),
  });
}

export async function POST(req: NextRequest) {
  const payload = await req.json().catch(() => null);
  if (!payload) return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });

  const secret = process.env.UAZAPI_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) return NextResponse.json({ ok: false, error: "Webhook indisponível." }, { status: 503 });
  const provided = req.headers.get("x-webhook-secret");
  if (provided !== secret) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const provider = new UazapiProvider({ baseUrl: "", token: "" });
  const normalized = provider.normalizeWebhook(payload);
  const supabase = getSupabaseAdmin();
  const payloadToken = typeof payload?.token === "string" ? payload.token : null;
  const instanceName = typeof payload?.instanceName === "string" ? payload.instanceName : null;

  try {
    let instance: any = null;

    if (payloadToken) {
      const { data, error } = await supabase
        .from("instances")
        .select("id,name,instance_role,account_id")
        .eq("api_token", payloadToken)
        .maybeSingle();
      if (error) throw error;
      instance = data;
    }

    if (!instance && instanceName) {
      const { data, error } = await supabase
        .from("instances")
        .select("id,name,instance_role")
        .eq("name", instanceName)
        .maybeSingle();
      if (error) throw error;
      instance = data;
    }

    // A relação com a conta precisa ser determinada pela instância autenticada.
    // Não aceitar eventos desconhecidos no banco multitenant.
    if (!instance?.id || !instance?.account_id) {
      return NextResponse.json({ ok: true, ignored: true, reason: "unknown_instance" });
    }

    const safePayload = sanitizePayload(payload);

    const { data: evt, error: evtErr } = await supabase
      .from("webhook_events")
      .insert({
        instance_id: instance.id,
        account_id: instance.account_id,
        provider: "uazapi",
        event_type: normalized.type,
        group_external_id: normalized.groupId ?? null,
        participant_external_id: normalized.participantId ?? null,
        phone: normalized.phone,
        lid: normalized.lid,
        payload: safePayload,
        processed: false,
      })
      .select("id")
      .single();

    if (evtErr || !evt) throw evtErr ?? new Error("webhook_event_not_saved");

    const markProcessed = async (processingError: string | null = null) => {
      await supabase
        .from("webhook_events")
        .update({ processed: true, processing_error: processingError, processed_at: new Date().toISOString() })
        .eq("id", evt.id);
    };

    if (normalized.type !== "participant_joined" || !normalized.participantId) {
      await markProcessed();
      return NextResponse.json({ ok: true, ignored: true, reason: "not_participant_join", normalized });
    }

    if (!instance?.id) {
      await markProcessed("instance_not_identified");
      return NextResponse.json({ ok: true, ignored: true, reason: "instance_not_identified", normalized });
    }

    if (instance.instance_role !== "monitor") {
      await markProcessed("instance_not_monitor");
      return NextResponse.json({ ok: true, ignored: true, reason: "instance_not_monitor", normalized });
    }

    const { data: group, error: groupError } = normalized.groupId
      ? await supabase
          .from("groups")
          .select("id,instance_id,name,external_id,monitoring_enabled")
          .eq("instance_id", instance.id)
          .eq("external_id", normalized.groupId)
          .maybeSingle()
      : { data: null, error: null };

    if (groupError) throw groupError;

    if (!group?.monitoring_enabled) {
      await markProcessed();
      return NextResponse.json({ ok: true, ignored: true, reason: group ? "group_not_monitored" : "group_not_found_for_instance", normalized });
    }

    const now = new Date().toISOString();
    const dedupeKey = leadDedupeKey(group.external_id, normalized);
    let existingLead: any = null;

    if (dedupeKey) {
      const { data, error } = await supabase.from("leads").select("id,capture_count").eq("dedupe_key", dedupeKey).maybeSingle();
      if (error) throw error;
      existingLead = data;
    }

    if (!existingLead && group.external_id) {
      const identifiers = [
        normalized.phone ? `phone.eq.${normalized.phone}` : null,
        normalized.lid ? `lid.eq.${normalized.lid}` : null,
        normalized.participantId ? `external_participant_id.eq.${normalized.participantId}` : null,
      ].filter(Boolean).join(",");

      if (identifiers) {
        const { data, error } = await supabase
          .from("leads")
          .select("id,capture_count")
          .eq("source_group_external_id", group.external_id)
          .or(identifiers)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        existingLead = data;
      }
    }

    let leadId: string;
    let duplicate = false;
    const identityType = normalized.phone ? "phone" : normalized.lid ? "lid" : "participant_id";

    if (existingLead?.id) {
      duplicate = true;
      const { error: updateLeadError } = await supabase.from("leads").update({
        phone: normalized.phone,
        lid: normalized.lid,
        external_participant_id: normalized.participantId,
        last_seen_at: now,
        capture_count: Number(existingLead.capture_count || 1) + 1,
        dedupe_key: dedupeKey,
        metadata: { source_event_id: evt.id, last_monitor_instance_id: instance.id, duplicate_capture: true, identity_type: identityType },
        updated_at: now,
      }).eq("id", existingLead.id);
      if (updateLeadError) throw updateLeadError;
      leadId = existingLead.id;
    } else {
      const insertPayload = {
        account_id: instance.account_id,
        instance_id: instance.id,
        group_id: group.id,
        external_participant_id: normalized.participantId,
        phone: normalized.phone,
        lid: normalized.lid,
        source: "group_join",
        source_group_external_id: group.external_id,
        dedupe_key: dedupeKey,
        capture_count: 1,
        consent_status: "unknown",
        status: "captured",
        first_seen_at: now,
        last_seen_at: now,
        metadata: { source_event_id: evt.id, first_monitor_instance_id: instance.id, identity_type: identityType },
      };

      const { data: createdLead, error: createLeadError } = await supabase.from("leads").insert(insertPayload).select("id").single();

      if (createLeadError) {
        if (dedupeKey && createLeadError.code === "23505") {
          const { data: racedLead, error: racedError } = await supabase.from("leads").select("id,capture_count").eq("dedupe_key", dedupeKey).single();
          if (racedError || !racedLead) throw racedError ?? createLeadError;
          duplicate = true;
          leadId = racedLead.id;
          await supabase.from("leads").update({ last_seen_at: now, capture_count: Number(racedLead.capture_count || 1) + 1, updated_at: now }).eq("id", racedLead.id);
        } else throw createLeadError;
      } else if (!createdLead) throw new Error("lead_not_created");
      else leadId = createdLead.id;
    }

    const { data: automationConfig } = await supabase
      .from("group_automations")
      .select("active,include_new_leads")
      .eq("group_id", group.id)
      .maybeSingle();

    let automationResult: any = { queued: false, reason: "new_leads_disabled_or_no_automation" };
    const identity = canonicalIdentity(normalized);
    const shouldQueueNew = Boolean(automationConfig?.active && automationConfig?.include_new_leads);

    if (identity && shouldQueueNew) {
      try {
        automationResult = await enqueueForAutomation({
          leadId,
          groupId: group.id,
          groupExternalId: group.external_id,
          identity,
          sourceTimestamp: typeof payload?.event?.Timestamp === "string" ? payload.event.Timestamp : null,
        });
      } catch (automationError) {
        automationResult = { queued: false, error: automationError instanceof Error ? automationError.message : "automation_error" };
      }
    }

    await markProcessed(automationResult?.error ? `automation:${automationResult.error}` : null);

    return NextResponse.json({
      ok: true,
      captured: true,
      duplicate,
      lead_id: leadId,
      automation: automationResult,
      monitor_instance: { id: instance.id, name: instance.name },
      group: { id: group.id, name: group.name, external_id: group.external_id },
      normalized,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: "processing_failed", detail: error instanceof Error ? error.message : "unknown error", normalized }, { status: 500 });
  }
}
