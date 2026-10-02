export type GroupAdditionLead = {
  phone: string;
  name?: string | null;
};

export type GroupAdditionInstance = {
  id: string;
  name: string;
  phone: string | null;
  status: string;
  base_url: string | null;
  api_token: string | null;
};

export function normalizeGroupAdditionPhone(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return "";
  return digits;
}

function localDateKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function localHour(date: Date) {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date));
}

function atLocalHour(dateKey: string, hour: number) {
  return new Date(`${dateKey}T${String(hour).padStart(2, "0")}:00:00-03:00`);
}

function nextLocalDateKey(dateKey: string) {
  const noon = new Date(`${dateKey}T12:00:00-03:00`);
  noon.setUTCDate(noon.getUTCDate() + 1);
  return localDateKey(noon);
}

function ensureWorkWindow(date: Date, startHour: number, endHour: number) {
  let current = new Date(date.getTime());
  const key = localDateKey(current);
  const hour = localHour(current);

  if (hour < startHour) return atLocalHour(key, startHour);
  if (hour >= endHour) return atLocalHour(nextLocalDateKey(key), startHour);
  return current;
}

export function buildGroupAdditionSchedule(params: {
  leads: GroupAdditionLead[];
  senderIds: string[];
  existingReservations?: Array<{
    instance_id: string;
    status: string;
    scheduled_at: string | null;
    processed_at: string | null;
  }>;
  dailyLimit: number;
  intervalMinutes: number;
  workStartHour: number;
  workEndHour: number;
  startAt?: Date;
}) {
  const dailyLimit = Math.min(15, Math.max(1, Math.round(params.dailyLimit)));
  const intervalMs = Math.max(1, Math.round(params.intervalMinutes)) * 60_000;
  const startHour = Math.max(0, Math.min(22, Math.round(params.workStartHour)));
  const endHour = Math.max(startHour + 1, Math.min(23, Math.round(params.workEndHour)));
  const counts = new Map<string, number>();

  for (const row of params.existingReservations || []) {
    if (!["queued", "processing", "added"].includes(row.status)) continue;
    const raw = row.status === "added" ? row.processed_at : row.scheduled_at;
    if (!raw) continue;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) continue;
    const key = `${row.instance_id}|${localDateKey(parsed)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  let cursor = ensureWorkWindow(params.startAt || new Date(Date.now() + 60_000), startHour, endHour);
  let senderCursor = 0;
  const jobs: Array<{
    instanceId: string;
    phone: string;
    leadName: string | null;
    sequence: number;
    scheduledAt: string;
  }> = [];

  for (let sequence = 0; sequence < params.leads.length; sequence++) {
    const lead = params.leads[sequence];
    let selectedSender = "";
    let guard = 0;

    while (!selectedSender) {
      guard += 1;
      if (guard > params.senderIds.length * 370) {
        throw new Error("Não foi possível montar a agenda da fila.");
      }

      cursor = ensureWorkWindow(cursor, startHour, endHour);
      const day = localDateKey(cursor);

      for (let offset = 0; offset < params.senderIds.length; offset++) {
        const index = (senderCursor + offset) % params.senderIds.length;
        const senderId = params.senderIds[index];
        const usageKey = `${senderId}|${day}`;
        if ((counts.get(usageKey) || 0) < dailyLimit) {
          selectedSender = senderId;
          senderCursor = (index + 1) % params.senderIds.length;
          counts.set(usageKey, (counts.get(usageKey) || 0) + 1);
          break;
        }
      }

      if (!selectedSender) {
        cursor = atLocalHour(nextLocalDateKey(day), startHour);
      }
    }

    jobs.push({
      instanceId: selectedSender,
      phone: lead.phone,
      leadName: lead.name || null,
      sequence: sequence + 1,
      scheduledAt: cursor.toISOString(),
    });

    cursor = ensureWorkWindow(new Date(cursor.getTime() + intervalMs), startHour, endHour);
  }

  const byDay = new Map<string, number>();
  for (const job of jobs) {
    const day = localDateKey(new Date(job.scheduledAt));
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }

  return {
    jobs,
    estimatedFinishAt: jobs.length ? jobs[jobs.length - 1].scheduledAt : null,
    plannedByDay: Array.from(byDay.entries()).map(([date, total]) => ({ date, total })),
  };
}

export async function validateInstanceGroupAdmin(instance: GroupAdditionInstance, groupJid: string) {
  if (instance.status !== "connected" || !instance.base_url || !instance.api_token) {
    return { ok: false, reason: "Conexão offline ou sem credenciais." };
  }

  const baseUrl = String(instance.base_url).replace(/\/$/, "");
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    token: String(instance.api_token),
  };

  try {
    const invite = await fetch(`${baseUrl}/group/invitelink/${encodeURIComponent(groupJid)}`, {
      method: "GET",
      headers,
      cache: "no-store",
    });
    if (invite.ok) return { ok: true, reason: "Administrador confirmado." };
  } catch {}

  try {
    const info = await fetch(`${baseUrl}/group/info`, {
      method: "POST",
      headers,
      body: JSON.stringify({ groupjid: groupJid, getInviteLink: true, force: false }),
      cache: "no-store",
    });

    const text = await info.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch {}

    if (!info.ok) {
      return { ok: false, reason: `A conexão não conseguiu acessar o grupo (UAZAPI ${info.status}).` };
    }

    const phone = normalizeGroupAdditionPhone(instance.phone);
    const participants = Array.isArray(body?.Participants) ? body.Participants : [];
    const me = phone
      ? participants.find((participant: any) => normalizeGroupAdditionPhone(participant?.JID) === phone)
      : null;

    if (me && (me?.IsAdmin === true || me?.IsSuperAdmin === true)) {
      return { ok: true, reason: "Administrador confirmado." };
    }

    if (me) return { ok: false, reason: "A conexão está no grupo, mas não é administradora." };
    return { ok: false, reason: "Não foi possível confirmar esta conexão como administradora do grupo." };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Falha ao validar grupo.",
    };
  }
}
