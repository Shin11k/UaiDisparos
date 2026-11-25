import { NextResponse } from "next/server";
import { authorizedQueueRequest } from "@/lib/auth/queue";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function buildPushcutBody(eventType: string, payload: any) {
  if (eventType === "group_sent") {
    return {
      title: "✅ Mensagem enviada no grupo",
      text: [payload?.recipient ? `+${payload.recipient}` : null, payload?.group_name, payload?.campaign_name, payload?.sender_name]
        .filter(Boolean)
        .join(" • "),
      event: eventType,
      data: payload ?? {},
    };
  }

  if (eventType === "private_sent") {
    return {
      title: "✅ Mensagem enviada no privado",
      text: [payload?.phone ? `+${payload.phone}` : null, payload?.broadcast_name, payload?.campaign_name, payload?.sender_name]
        .filter(Boolean)
        .join(" • "),
      event: eventType,
      data: payload ?? {},
    };
  }

  return {
    title: "⚠️ Número desconectou",
    text: [payload?.name, payload?.phone ? `+${payload.phone}` : null].filter(Boolean).join(" • "),
    event: eventType,
    data: payload ?? {},
  };
}

async function sendWebhook(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (response.ok) return { ok: true, status: response.status };

  if (response.status === 405) {
    const fallback = await fetch(url, { method: "GET", cache: "no-store" });
    if (fallback.ok) return { ok: true, status: fallback.status };
  }

  const text = await response.text().catch(() => "");
  return { ok: false, status: response.status, error: text.slice(0, 500) };
}

export async function POST(request: Request) {
  if (!authorizedQueueRequest(request)) return NextResponse.json({ ok: false, error: "Não autorizado." }, { status: 401 });
  try {
    const supabase = getSupabaseAdmin();
    const [{ data: settings }, { data: events, error }] = await Promise.all([
      supabase
        .from("notification_settings")
        .select("group_sent_url,private_sent_url,disconnected_url")
        .eq("id", 1)
        .single(),
      supabase
        .from("notification_outbox")
        .select("id,event_type,payload,attempts")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(30),
    ]);

    if (error) throw error;

    const results: any[] = [];
    for (const event of events ?? []) {
      const url = event.event_type === "group_sent"
        ? settings?.group_sent_url
        : event.event_type === "private_sent"
          ? settings?.private_sent_url
          : settings?.disconnected_url;

      if (!url) {
        await supabase
          .from("notification_outbox")
          .update({ status: "skipped", processed_at: new Date().toISOString(), error_message: "Webhook não configurado" })
          .eq("id", event.id);
        results.push({ id: event.id, skipped: true });
        continue;
      }

      try {
        const result = await sendWebhook(String(url), buildPushcutBody(event.event_type, event.payload));
        if (result.ok) {
          await supabase
            .from("notification_outbox")
            .update({ status: "sent", processed_at: new Date().toISOString(), error_message: null, attempts: Number(event.attempts || 0) + 1 })
            .eq("id", event.id);
          results.push({ id: event.id, sent: true });
        } else {
          const attempts = Number(event.attempts || 0) + 1;
          await supabase
            .from("notification_outbox")
            .update({
              status: attempts >= 3 ? "failed" : "pending",
              attempts,
              error_message: `HTTP ${result.status}${result.error ? `: ${result.error}` : ""}`,
              processed_at: attempts >= 3 ? new Date().toISOString() : null,
            })
            .eq("id", event.id);
          results.push({ id: event.id, sent: false, status: result.status });
        }
      } catch (error) {
        const attempts = Number(event.attempts || 0) + 1;
        const message = error instanceof Error ? error.message : "Erro ao chamar webhook";
        await supabase
          .from("notification_outbox")
          .update({
            status: attempts >= 3 ? "failed" : "pending",
            attempts,
            error_message: message.slice(0, 500),
            processed_at: attempts >= 3 ? new Date().toISOString() : null,
          })
          .eq("id", event.id);
        results.push({ id: event.id, sent: false, error: message });
      }
    }

    return NextResponse.json({ ok: true, processed: results.length, results });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Erro ao processar notificações." },
      { status: 500 },
    );
  }
}
