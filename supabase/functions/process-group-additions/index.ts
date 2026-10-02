import { createClient } from "npm:@supabase/supabase-js@2";

const headers = { "Content-Type": "application/json" };

function saoPauloDayBounds(date = new Date()) {
  const local = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  return {
    start: new Date(Date.UTC(y, m, d, 3, 0, 0, 0)).toISOString(),
    end: new Date(Date.UTC(y, m, d + 1, 3, 0, 0, 0)).toISOString(),
  };
}

function nextWorkStart(hour: number) {
  const now = new Date();
  const local = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return new Date(Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + 1,
    hour + 3,
    0, 0, 0,
  )).toISOString();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST required" }), { status: 405, headers });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) {
    return new Response(JSON.stringify({ ok: false, error: "Supabase runtime env missing" }), { status: 500, headers });
  }

  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: claimed, error: claimError } = await supabase.rpc("claim_group_addition_jobs", { p_limit: 1 });
  if (claimError) {
    return new Response(JSON.stringify({ ok: false, error: claimError.message }), { status: 500, headers });
  }

  const results: any[] = [];

  for (const job of claimed || []) {
    try {
      const [{ data: campaign }, { data: instance }] = await Promise.all([
        supabase.from("group_addition_campaigns")
          .select("id,status,authorization_confirmed,group_external_id,daily_limit_per_sender,work_start_hour")
          .eq("id", job.campaign_id).single(),
        supabase.from("instances")
          .select("id,name,status,base_url,api_token")
          .eq("id", job.instance_id).single(),
      ]);

      if (!campaign || campaign.status !== "active" || !campaign.authorization_confirmed) {
        await supabase.from("group_addition_jobs").update({
          status: "cancelled",
          error_message: "Campanha inativa, cancelada ou sem autorização.",
          processed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", job.id);
        continue;
      }

      if (!instance || instance.status !== "connected" || !instance.base_url || !instance.api_token) {
        await supabase.from("group_addition_jobs").update({
          status: "queued",
          scheduled_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          error_message: "Conexão offline ou incompleta. Nova tentativa em 5 minutos.",
          updated_at: new Date().toISOString(),
        }).eq("id", job.id);
        continue;
      }

      const bounds = saoPauloDayBounds();
      const { count: usedToday } = await supabase.from("group_addition_jobs")
        .select("id", { count: "exact", head: true })
        .eq("instance_id", job.instance_id)
        .eq("status", "added")
        .gte("processed_at", bounds.start)
        .lt("processed_at", bounds.end);

      const dailyLimit = Math.min(15, Math.max(1, Number(campaign.daily_limit_per_sender || 15)));
      if (Number(usedToday || 0) >= dailyLimit) {
        await supabase.from("group_addition_jobs").update({
          status: "queued",
          scheduled_at: nextWorkStart(Number(campaign.work_start_hour || 8)),
          error_message: "Limite diário desta conexão atingido. Reagendado para o próximo dia.",
          updated_at: new Date().toISOString(),
        }).eq("id", job.id);
        continue;
      }

      const response = await fetch(String(instance.base_url).replace(/\/$/, "") + "/group/updateParticipants", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          token: String(instance.api_token),
        },
        body: JSON.stringify({
          groupjid: campaign.group_external_id,
          action: "add",
          participants: [job.phone],
        }),
      });

      const raw = await response.text();
      let payload: any = raw;
      try { payload = raw ? JSON.parse(raw) : null; } catch {}

      if (!response.ok) {
        await supabase.from("group_addition_jobs").update({
          status: "failed",
          provider_response: typeof payload === "object" ? payload : { raw: String(payload) },
          error_message: "UAZAPI " + response.status + ": " + (typeof payload === "string" ? payload.slice(0, 500) : JSON.stringify(payload).slice(0, 500)),
          processed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", job.id);
        continue;
      }

      const updates = Array.isArray(payload?.groupUpdated) ? payload.groupUpdated : [];
      const participantResult = updates[0] || null;
      const providerError = participantResult && Number(participantResult?.Error ?? 0) !== 0
        ? Number(participantResult.Error)
        : 0;

      const now = new Date().toISOString();
      if (providerError !== 0) {
        await supabase.from("group_addition_jobs").update({
          status: "failed",
          provider_response: payload,
          error_message: "UAZAPI retornou erro " + providerError + " para este participante.",
          processed_at: now,
          updated_at: now,
        }).eq("id", job.id);
      } else {
        await supabase.from("group_addition_jobs").update({
          status: "added",
          provider_response: payload,
          error_message: null,
          processed_at: now,
          updated_at: now,
        }).eq("id", job.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await supabase.from("group_addition_jobs").update({
        status: "failed",
        error_message: message.slice(0, 700),
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", job.id);
    }
  }

  const campaignIds = [...new Set((claimed || []).map((job: any) => job.campaign_id))];
  for (const campaignId of campaignIds) {
    const { count: pending } = await supabase.from("group_addition_jobs")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .in("status", ["queued", "processing"]);

    if (Number(pending || 0) === 0) {
      await supabase.from("group_addition_campaigns").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", campaignId).eq("status", "active");
    }
  }

  return new Response(JSON.stringify({ ok: true, processed: results.length }), { headers });
});
