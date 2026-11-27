import { getSupabaseAdmin } from "@/lib/supabase/server";
import { UazapiProvider } from "@/lib/providers/uazapi";

type LeadLike = { id: string; phone: string | null; lid: string | null; name?: string | null };
type GroupLike = { id: string; name: string | null; external_id: string };

export function renderCampaignText(template: string | null, lead: LeadLike, group: GroupLike) {
  const now = new Date();
  const replacements: Record<string, string> = {
    nome: lead.name || "",
    telefone: lead.phone || lead.lid || "",
    grupo: group.name || group.external_id,
    data: new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(now),
    hora: new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(now),
  };
  return String(template || "").replace(/\{\{\s*(nome|telefone|grupo|data|hora)\s*\}\}/gi, (_, key) => replacements[String(key).toLowerCase()] ?? "");
}

function extractMessageId(value: any) {
  return value?.messageId || value?.id || value?.key?.id || value?.data?.messageId || value?.data?.id || null;
}

function normalizeButtons(buttons: any) {
  if (!Array.isArray(buttons)) return [];
  return buttons.map((button, index) => ({
    label: String(button?.label || button?.text || button?.value || "").trim().slice(0, 30),
    value: String(button?.value || button?.id || `btn_${index + 1}`).trim().slice(0, 250),
    type: ["reply", "url", "call", "copy"].includes(String(button?.type)) ? String(button.type) : "reply",
    id: String(button?.id || `btn_${index + 1}`).trim().slice(0, 50),
  })).filter((button) => button.label && button.value).slice(0, 3);
}

function normalizeDirectRecipient(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  // A UAZAPI aceita número ou chat ID. LID não pode perder o sufixo @lid,
  // pois os dígitos do LID não são o número de telefone do participante.
  if (raw.endsWith("@lid") || raw.endsWith("@s.whatsapp.net")) return raw;
  return raw.replace(/\D/g, "");
}

function resolveLeadRecipient(lead: { phone?: string | null; lid?: string | null }, preferred?: string | null) {
  const preferredRecipient = normalizeDirectRecipient(preferred);
  if (preferredRecipient) return preferredRecipient;

  const phone = normalizeDirectRecipient(lead.phone);
  if (phone) return phone;

  const lid = normalizeDirectRecipient(lead.lid);
  if (lid?.endsWith("@lid")) return lid;

  return "";
}

function tenSecondBucket(sourceTimestamp?: string | null) {
  const parsed = sourceTimestamp ? Date.parse(sourceTimestamp) : NaN;
  const value = Number.isFinite(parsed) ? parsed : Date.now();
  return new Date(Math.floor(value / 10000) * 10000).toISOString();
}

function isDisconnectedSessionError(message: string) {
  const value = message.toLowerCase();
  return value.includes("whatsapp disconnected") || value.includes("session is not reconnectable") || value.includes("uazapi request failed: 503");
}

function saoPauloDayStartIso() {
  const now = new Date();
  const local = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}T03:00:00.000Z`;
}

async function selectSenderForAutomation(supabase: any, automation: any, preferredId?: string | null) {
  const senderIds: string[] = automation.sender_instance_ids?.length
    ? automation.sender_instance_ids
    : automation.sender_instance_id ? [automation.sender_instance_id] : [];
  if (!senderIds.length) return { sender: null, reason: "no_sender" };

  const [{ data: senders }, { data: todayJobs }] = await Promise.all([
    supabase.from("instances").select("id,name,status,instance_role,base_url,api_token").in("id", senderIds),
    supabase.from("jobs").select("instance_id,status,processed_at,updated_at").in("instance_id", senderIds).in("status", ["sent", "processing"]).gte("created_at", saoPauloDayStartIso()),
  ]);

  const counts = new Map<string, number>();
  const lastActivity = new Map<string, number>();
  for (const job of todayJobs || []) {
    counts.set(job.instance_id, (counts.get(job.instance_id) || 0) + 1);
    const raw = job.processed_at || job.updated_at;
    const ts = raw ? Date.parse(raw) : NaN;
    if (Number.isFinite(ts)) lastActivity.set(job.instance_id, Math.max(lastActivity.get(job.instance_id) || 0, ts));
  }

  const limit = Number(automation.daily_limit_per_sender || 40);
  const intervalMs = Math.max(0, Number(automation.send_interval_seconds ?? 30)) * 1000;
  const nowMs = Date.now();
  const byId = new Map((senders || []).map((sender: any) => [sender.id, sender]));
  const ordered = preferredId && senderIds.includes(preferredId)
    ? [preferredId, ...senderIds.filter((id) => id !== preferredId)]
    : senderIds;

  let nextAvailableAt: number | null = null;
  let hasConnectedUnderLimit = false;

  for (const id of ordered) {
    const sender: any = byId.get(id);
    if (!sender || sender.instance_role !== "sender") continue;
    if ((counts.get(id) || 0) >= limit) continue;
    if (sender.status !== "connected" || !sender.base_url || !sender.api_token) continue;

    hasConnectedUnderLimit = true;
    const last = lastActivity.get(id) || 0;
    const availableAt = last + intervalMs;
    if (intervalMs > 0 && last > 0 && availableAt > nowMs) {
      nextAvailableAt = nextAvailableAt === null ? availableAt : Math.min(nextAvailableAt, availableAt);
      continue;
    }

    return { sender, usedToday: counts.get(id) || 0, limit };
  }

  if (hasConnectedUnderLimit && nextAvailableAt) {
    return { sender: null, reason: "cooldown", nextAvailableAt: new Date(nextAvailableAt).toISOString(), limit };
  }

  const availableUnderLimit = ordered.find((id) => (counts.get(id) || 0) < limit && byId.get(id));
  if (availableUnderLimit) return { sender: byId.get(availableUnderLimit), usedToday: counts.get(availableUnderLimit) || 0, limit, offline: true };
  return { sender: null, reason: "daily_limit_reached", limit };
}

export async function processJob(jobId: string) {
  const supabase = getSupabaseAdmin();
  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("id,status,attempts,lead_id,group_id,campaign_id,automation_id,instance_id,recipient,payload,scheduled_at")
    .eq("id", jobId)
    .single();

  if (jobError || !job) throw jobError ?? new Error("Job não encontrado.");
  if (job.status === "sent") return { ok: true, alreadySent: true };
  if (job.scheduled_at && new Date(job.scheduled_at).getTime() > Date.now()) return { ok: false, queued: true, reason: "scheduled" };

  const [{ data: lead }, { data: group }, { data: campaign }, { data: automation }] = await Promise.all([
    supabase.from("leads").select("id,phone,lid,name,consent_status").eq("id", job.lead_id).single(),
    supabase.from("groups").select("id,name,external_id").eq("id", job.group_id).single(),
    supabase.from("campaigns").select("id,name,text_content,media_url,media_type,buttons,footer_text").eq("id", job.campaign_id).single(),
    supabase.from("group_automations").select("id,active,authorization_confirmed,sender_instance_id,sender_instance_ids,daily_limit_per_sender,send_interval_seconds").eq("id", job.automation_id).single(),
  ]);

  if (!lead || !group || !campaign || !automation) {
    await supabase.from("jobs").update({ status: "failed", error_message: "Dados incompletos do job", processed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", job.id);
    return { ok: false, error: "Dados incompletos do job" };
  }

  // Captured contacts from the September backup have unknown consent.
  // Do not send direct outreach until consent is recorded explicitly.
  if (!["opted_in", "manual_authorized"].includes(String(lead.consent_status))) {
    await supabase.from("jobs").update({
      status: "paused",
      error_message: "Destinatário sem autorização registrada",
      updated_at: new Date().toISOString(),
    }).eq("id", job.id);
    return { ok: false, paused: true, reason: "consent_required" };
  }

  if (!automation.active || !automation.authorization_confirmed) {
    await supabase.from("jobs").update({ status: "paused", error_message: "Automação inativa ou sem confirmação de autorização", updated_at: new Date().toISOString() }).eq("id", job.id);
    return { ok: false, paused: true };
  }

  const senderChoice = await selectSenderForAutomation(supabase, automation, job.instance_id);
  if (!senderChoice.sender) {
    let detail = "Nenhum disparador disponível";
    const updates: Record<string, any> = { status: "queued", processed_at: null, updated_at: new Date().toISOString() };

    if (senderChoice.reason === "daily_limit_reached") {
      detail = "Limite diário das contas atingido — aguardando próximo período";
    } else if (senderChoice.reason === "cooldown") {
      detail = `Aguardando intervalo entre envios (${Number(automation.send_interval_seconds ?? 30)}s)`;
      if (senderChoice.nextAvailableAt) updates.scheduled_at = senderChoice.nextAvailableAt;
    }

    updates.error_message = detail;
    await supabase.from("jobs").update(updates).eq("id", job.id);
    return { ok: false, queued: true, error: detail };
  }

  const sender: any = senderChoice.sender;
  if (senderChoice.offline || sender.status !== "connected" || !sender.base_url || !sender.api_token) {
    await supabase.from("jobs").update({ instance_id: sender.id, status: "queued", error_message: "Contas disponíveis estão offline — aguardando reconexão", processed_at: null, updated_at: new Date().toISOString() }).eq("id", job.id);
    return { ok: false, queued: true, error: "Disparadores offline" };
  }

  if (job.instance_id !== sender.id) {
    await supabase.from("jobs").update({ instance_id: sender.id, updated_at: new Date().toISOString() }).eq("id", job.id);
  }

  const recipient = resolveLeadRecipient(lead, job.recipient);
  if (!recipient) {
    await supabase.from("jobs").update({ status: "failed", error_message: "Lead sem telefone ou LID utilizável", processed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", job.id);
    return { ok: false, error: "Lead sem telefone ou LID utilizável" };
  }

  let suppressed = null;
  if (lead.phone) {
    const phone = String(lead.phone).replace(/\D/g, "");
    const { data } = await supabase.from("suppression_list").select("id").eq("phone", phone).limit(1).maybeSingle();
    suppressed = data;
  }
  if (!suppressed && lead.lid) {
    const { data } = await supabase.from("suppression_list").select("id").eq("lid", lead.lid).limit(1).maybeSingle();
    suppressed = data;
  }
  if (suppressed) {
    await supabase.from("jobs").update({ status: "failed", error_message: "Destinatário na lista de supressão", processed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", job.id);
    return { ok: false, error: "Destinatário na lista de supressão" };
  }

  const text = renderCampaignText(campaign.text_content, lead, group);
  const provider = new UazapiProvider({ baseUrl: sender.base_url, token: sender.api_token });
  const buttons = normalizeButtons(campaign.buttons);
  await supabase.from("jobs").update({ status: "processing", attempts: Number(job.attempts || 0) + 1, error_message: null, scheduled_at: null, updated_at: new Date().toISOString() }).eq("id", job.id);

  try {
    const ids: string[] = [];
    if (campaign.media_url && campaign.media_type && campaign.media_type !== "none") {
      const mediaResult: any = await provider.sendMedia({ number: recipient, file: campaign.media_url, type: campaign.media_type as any, text: buttons.length ? "" : text });
      const mediaId = extractMessageId(mediaResult);
      if (mediaId) ids.push(String(mediaId));
    }

    if (buttons.length) {
      const menuResult: any = await provider.sendMenu({
        number: recipient,
        text: text || campaign.name,
        choices: buttons.map((button) => {
          if (button.type === "url") return `${button.label}|${button.value.startsWith("http") ? button.value : `url:${button.value}`}`;
          if (button.type === "call") return `${button.label}|${button.value.startsWith("call:") ? button.value : `call:${button.value}`}`;
          if (button.type === "copy") return `${button.label}|${button.value.startsWith("copy:") ? button.value : `copy:${button.value}`}`;
          return `${button.label}|${button.value}`;
        }),
        footerText: campaign.footer_text || "",
      });
      const menuId = extractMessageId(menuResult);
      if (menuId) ids.push(String(menuId));
    } else if (!campaign.media_url && text) {
      const textResult: any = await provider.sendText({ number: recipient, text, linkPreview: false });
      const textId = extractMessageId(textResult);
      if (textId) ids.push(String(textId));
    }

    const now = new Date().toISOString();
    await supabase.from("jobs").update({ status: "sent", instance_id: sender.id, provider_message_id: ids.join(",") || null, processed_at: now, error_message: null, payload: { ...(job.payload || {}), rendered_text: text, buttons, recipient_type: recipient.endsWith("@lid") ? "lid" : "phone" }, updated_at: now }).eq("id", job.id);
    return { ok: true, sent: true, senderId: sender.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro no envio";
    if (isDisconnectedSessionError(message)) {
      const now = new Date().toISOString();
      await Promise.all([
        supabase.from("instances").update({ status: "disconnected", updated_at: now }).eq("id", sender.id),
        supabase.from("jobs").update({ status: "queued", error_message: "Disparador desconectado — aguardando outra conta ou reconexão", processed_at: null, updated_at: now }).eq("id", job.id),
      ]);
      return { ok: false, queued: true, disconnected: true, error: message };
    }
    await supabase.from("jobs").update({ status: "failed", error_message: message, processed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", job.id);
    return { ok: false, error: message };
  }
}

export async function enqueueForAutomation(
  params: { leadId: string; groupId: string; groupExternalId: string; identity: string; sourceTimestamp?: string | null },
  supabaseOverride?: ReturnType<typeof getSupabaseAdmin>,
) {
  const supabase = supabaseOverride ?? getSupabaseAdmin();
  const { data: automation } = await supabase
    .from("group_automations")
    .select("id,campaign_id,sender_instance_id,campaign_ids,sender_instance_ids,delay_seconds,send_interval_seconds,daily_limit_per_sender,active,authorization_confirmed")
    .eq("group_id", params.groupId)
    .eq("active", true)
    .maybeSingle();

  if (!automation || !automation.authorization_confirmed) return { queued: false, reason: "no_active_authorized_automation" };

  const { data: lead } = await supabase.from("leads").select("phone,lid").eq("id", params.leadId).single();
  const recipient = resolveLeadRecipient(lead || {}, params.identity);
  if (!recipient) return { queued: false, reason: "lead_without_phone_or_lid" };

  const campaignIds: string[] = automation.campaign_ids?.length ? automation.campaign_ids : automation.campaign_id ? [automation.campaign_id] : [];
  if (!campaignIds.length) return { queued: false, reason: "automation_without_campaign" };

  const { count: previousJobs } = await supabase.from("jobs").select("id", { count: "exact", head: true }).eq("automation_id", automation.id);
  const sequence = Number(previousJobs || 0);
  const campaignId = campaignIds[sequence % campaignIds.length];
  const senderChoice = await selectSenderForAutomation(supabase, automation);
  const preferredSenderId = senderChoice.sender?.id || (automation.sender_instance_ids?.[0] || automation.sender_instance_id || null);

  const bucket = tenSecondBucket(params.sourceTimestamp);
  const dedupeKey = `${automation.id}|${params.groupExternalId}|${params.identity}|${bucket}`;
  const nowDate = new Date();
  const scheduledAt = new Date(nowDate.getTime() + Number(automation.delay_seconds || 0) * 1000).toISOString();
  const now = nowDate.toISOString();

  const { data: created, error } = await supabase.from("jobs").insert({
    campaign_id: campaignId,
    lead_id: params.leadId,
    instance_id: preferredSenderId,
    group_id: params.groupId,
    automation_id: automation.id,
    recipient,
    dedupe_key: dedupeKey,
    status: "queued",
    scheduled_at: scheduledAt,
    payload: { source: "group_join", group_external_id: params.groupExternalId, rotation_index: sequence, recipient_type: recipient.endsWith("@lid") ? "lid" : "phone" },
    created_at: now,
    updated_at: now,
  }).select("id").single();

  if (error) {
    if (error.code === "23505") return { queued: false, duplicate: true };
    throw error;
  }

  // O webhook/sincronizador apenas enfileira. O processador em nuvem escoa a fila em série,
  // respeitando atraso, intervalo por conta, limite diário e disponibilidade.
  return { queued: true, jobId: created.id, scheduledAt, recipientType: recipient.endsWith("@lid") ? "lid" : "phone" };
}
