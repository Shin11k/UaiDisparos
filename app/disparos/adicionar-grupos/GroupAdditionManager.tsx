"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";

type InstanceRow = {
  id: string;
  name: string;
  phone: string | null;
  status: string;
  instance_role: string;
};

type GroupRow = {
  id: string;
  name: string | null;
  external_id: string;
  member_count: number | null;
};

type LeadRow = { phone: string; name: string | null };

type ValidationRow = {
  id: string;
  name: string;
  phone: string | null;
  ok: boolean;
  reason: string;
};

type CampaignRow = {
  id: string;
  name: string;
  group_name: string | null;
  group_external_id: string;
  sender_instance_ids: string[];
  status: "active" | "paused" | "completed" | "cancelled";
  total_leads: number;
  daily_limit_per_sender: number;
  interval_minutes: number;
  starts_at: string;
  estimated_finish_at: string | null;
  created_at: string;
  counts: Record<string, number>;
  next_job: {
    phone: string;
    lead_name: string | null;
    instance_id: string;
    scheduled_at: string;
  } | null;
  last_errors: Array<{
    id: string;
    phone: string;
    lead_name: string | null;
    error_message: string;
    updated_at: string;
  }>;
};

function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : "";
}

function parseLeadText(text: string) {
  const unique = new Map<string, LeadRow>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const parts = line.split(/[;,\t|]/).map((part) => part.trim()).filter(Boolean);
    const candidates = parts.length ? parts : [line];
    let phone = "";
    let phoneIndex = -1;

    for (let i = 0; i < candidates.length; i++) {
      const normalized = normalizePhone(candidates[i]);
      if (normalized) {
        phone = normalized;
        phoneIndex = i;
        break;
      }
    }

    if (!phone) {
      const match = line.match(/(?:\+?\d[\d\s().-]{8,}\d)/);
      if (match) phone = normalizePhone(match[0]);
    }

    if (!phone || unique.has(phone)) continue;

    const name = candidates.find((value, index) => index !== phoneIndex && normalizePhone(value) === "")
      ?.slice(0, 120) || null;

    unique.set(phone, { phone, name });
  }

  return Array.from(unique.values()).slice(0, 5000);
}

function statusLabel(status: CampaignRow["status"]) {
  if (status === "active") return "Rodando";
  if (status === "paused") return "Pausada";
  if (status === "completed") return "Concluída";
  return "Cancelada";
}

function statusClass(status: CampaignRow["status"]) {
  if (status === "active" || status === "completed") return "ok";
  if (status === "paused") return "warn";
  return "";
}

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export default function GroupAdditionManager({
  initialInstances,
  initialGroups,
}: {
  initialInstances: InstanceRow[];
  initialGroups: GroupRow[];
}) {
  const [senderIds, setSenderIds] = useState<string[]>([]);
  const [groupId, setGroupId] = useState("");
  const [name, setName] = useState("");
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(3);
  const [dailyLimit, setDailyLimit] = useState(15);
  const [workStartHour, setWorkStartHour] = useState(8);
  const [workEndHour, setWorkEndHour] = useState(22);
  const [authorized, setAuthorized] = useState(false);
  const [validation, setValidation] = useState<ValidationRow[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [lastPlan, setLastPlan] = useState<Array<{ date: string; total: number }>>([]);

  const selectedGroup = useMemo(
    () => initialGroups.find((group) => group.id === groupId) || null,
    [initialGroups, groupId],
  );

  const uniqueSelectedNumbers = new Set(
    initialInstances
      .filter((instance) => senderIds.includes(instance.id))
      .map((instance) => instance.phone || instance.id),
  ).size;
  const dailyCapacity = uniqueSelectedNumbers * dailyLimit;
  const roughDays = dailyCapacity > 0 ? Math.ceil(leads.length / dailyCapacity) : 0;
  const todayRough = Math.min(leads.length, dailyCapacity);

  async function refreshCampaigns() {
    const response = await fetch("/api/group-additions", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok || !body?.ok) throw new Error(body?.error || "Erro ao carregar filas.");
    setCampaigns(body.campaigns || []);
  }

  useEffect(() => {
    refreshCampaigns().catch(() => {});
    const timer = window.setInterval(() => refreshCampaigns().catch(() => {}), 10000);
    return () => window.clearInterval(timer);
  }, []);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError("");
    try {
      const text = await file.text();
      const parsed = parseLeadText(text);
      if (!parsed.length) throw new Error("Não encontrei números válidos no arquivo.");

      setLeads(parsed);
      setFileName(file.name);
      setName((current) => current || "Add " + parsed.length + " em grupo");
      setLastPlan([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao ler arquivo.");
    } finally {
      event.target.value = "";
    }
  }

  function toggleSender(id: string) {
    setValidation([]);
    setLastPlan([]);
    setSenderIds((current) => current.includes(id)
      ? current.filter((value) => value !== id)
      : [...current, id]);
  }

  async function validateConnections() {
    if (!groupId || !senderIds.length) {
      setError("Escolha um grupo e pelo menos uma conexão.");
      return;
    }

    setBusy("validate");
    setError("");
    setValidation([]);

    try {
      const response = await fetch("/api/group-additions/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: groupId, sender_instance_ids: senderIds }),
      });
      const body = await response.json();
      setValidation(body?.validation || []);
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error || "Uma ou mais conexões não podem adicionar pessoas neste grupo.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao validar conexões.");
    } finally {
      setBusy("");
    }
  }

  async function createQueue(event: FormEvent) {
    event.preventDefault();
    setError("");
    setLastPlan([]);

    if (!leads.length) {
      setError("Suba uma lista de leads primeiro.");
      return;
    }
    if (!senderIds.length || !groupId) {
      setError("Escolha o grupo e as conexões.");
      return;
    }
    if (!authorized) {
      setError("Confirme a autorização dos contatos antes de iniciar.");
      return;
    }

    setBusy("create");

    try {
      const response = await fetch("/api/group-additions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name || "Add em " + (selectedGroup?.name || "grupo"),
          group_id: groupId,
          sender_instance_ids: senderIds,
          leads,
          daily_limit_per_sender: dailyLimit,
          interval_minutes: intervalMinutes,
          work_start_hour: workStartHour,
          work_end_hour: workEndHour,
          authorization_confirmed: true,
        }),
      });

      const body = await response.json();
      if (body?.validation) setValidation(body.validation);
      if (!response.ok || !body?.ok) throw new Error(body?.error || "Erro ao criar fila.");

      setLastPlan(body.planned_by_day || []);
      await refreshCampaigns();
      setLeads([]);
      setFileName("");
      setAuthorized(false);
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar fila.");
    } finally {
      setBusy("");
    }
  }

  async function campaignAction(campaign: CampaignRow, action: "pause" | "resume" | "cancel") {
    if (action === "cancel") {
      const confirmed = window.confirm(
        'Cancelar a fila "' + campaign.name + '"? Os contatos ainda pendentes não serão adicionados.',
      );
      if (!confirmed) return;
    }

    setBusy(action + ":" + campaign.id);
    setError("");

    try {
      const response = await fetch("/api/group-additions/" + campaign.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await response.json();
      if (!response.ok || !body?.ok) throw new Error(body?.error || "Erro ao alterar fila.");
      if (body?.planned_by_day) setLastPlan(body.planned_by_day);
      await refreshCampaigns();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao alterar fila.");
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="eyebrow">DISPAROS</div>
          <h1>Adicionar em grupos</h1>
          <div className="subtitle">
            Rodízio entre conexões: uma adição por vez, intervalo fixo e no máximo 15 por conexão/dia.
          </div>
        </div>
      </div>

      {error ? <div className="alert-error" style={{ marginBottom: 16 }}>{error}</div> : null}

      <form className="card" style={{ padding: 20, marginBottom: 18 }} onSubmit={createQueue}>
        <div className="section-title">1. Lista de leads</div>
        <div className="muted" style={{ marginTop: 4 }}>
          CSV ou TXT. Use números com DDI + DDD + número. Duplicados são removidos automaticamente.
        </div>

        <div className="row" style={{ gap: 10, marginTop: 12, flexWrap: "wrap" }}>
          <label className="btn secondary" style={{ cursor: "pointer" }}>
            Subir CSV/TXT
            <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={handleFile} style={{ display: "none" }} />
          </label>
          <span className="badge">{fileName || "Nenhum arquivo"}</span>
          <span className={"badge " + (leads.length ? "ok" : "")}>{leads.length} contatos válidos</span>
        </div>

        <div style={{ marginTop: 18 }}>
          <div className="section-title">2. Grupo</div>
          <select
            className="input"
            style={{ marginTop: 10, maxWidth: 620 }}
            value={groupId}
            onChange={(e) => { setGroupId(e.target.value); setValidation([]); setLastPlan([]); }}
          >
            <option value="">Selecione o grupo</option>
            {initialGroups.map((group) => (
              <option key={group.id} value={group.id}>
                {(group.name || group.external_id) + (group.member_count != null ? " • " + group.member_count + " membros" : "")}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginTop: 18 }}>
          <div className="section-title">3. Conexões que vão adicionar</div>
          <div className="muted" style={{ marginTop: 4 }}>
            Cada conexão selecionada precisa estar no grupo e possuir permissão de administrador.
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10, marginTop: 10 }}>
            {initialInstances.map((instance) => (
              <label key={instance.id} className="card" style={{ padding: 14, cursor: "pointer" }}>
                <div className="row" style={{ gap: 9 }}>
                  <input
                    type="checkbox"
                    checked={senderIds.includes(instance.id)}
                    onChange={() => toggleSender(instance.id)}
                  />
                  <div>
                    <strong>{instance.name}</strong>
                    <div className="muted" style={{ marginTop: 3 }}>
                      {(instance.phone ? "+" + instance.phone : "sem número") + " • " + (instance.instance_role === "sender" ? "disparador" : "monitor")}
                    </div>
                  </div>
                </div>
              </label>
            ))}
          </div>

          <button
            type="button"
            className="btn secondary"
            style={{ marginTop: 10 }}
            disabled={busy === "validate" || !groupId || !senderIds.length}
            onClick={validateConnections}
          >
            {busy === "validate" ? "Validando..." : "Validar conexões no grupo"}
          </button>

          {validation.length ? (
            <div style={{ display: "grid", gap: 7, marginTop: 10 }}>
              {validation.map((item) => (
                <div className={"badge " + (item.ok ? "ok" : "warn")} key={item.id} style={{ justifyContent: "space-between" }}>
                  <span>{item.name + (item.phone ? " • +" + item.phone : "")}</span>
                  <span>{item.ok ? "Pronta" : item.reason}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div style={{ marginTop: 18 }}>
          <div className="section-title">4. Ritmo da fila</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10, marginTop: 10 }}>
            <label className="field">
              <span>Máximo por conexão/dia</span>
              <input className="input" type="number" min={1} max={15} value={dailyLimit} onChange={(e) => setDailyLimit(Math.min(15, Math.max(1, Number(e.target.value))))} />
            </label>
            <label className="field">
              <span>Intervalo entre adições</span>
              <div className="row" style={{ gap: 6 }}>
                <input className="input" type="number" min={1} max={60} value={intervalMinutes} onChange={(e) => setIntervalMinutes(Math.min(60, Math.max(1, Number(e.target.value))))} />
                <span className="badge">min</span>
              </div>
            </label>
            <label className="field">
              <span>Começar a operar às</span>
              <input className="input" type="number" min={0} max={22} value={workStartHour} onChange={(e) => setWorkStartHour(Math.min(22, Math.max(0, Number(e.target.value))))} />
            </label>
            <label className="field">
              <span>Parar às</span>
              <input className="input" type="number" min={workStartHour + 1} max={23} value={workEndHour} onChange={(e) => setWorkEndHour(Math.min(23, Math.max(workStartHour + 1, Number(e.target.value))))} />
            </label>
          </div>
        </div>

        <div className="instance-summary-grid" style={{ marginTop: 18 }}>
          <div className="card"><div className="label">Lista</div><div className="metric">{leads.length}</div><div className="muted">contatos</div></div>
          <div className="card"><div className="label">Conexões</div><div className="metric">{senderIds.length}</div><div className="muted">selecionadas</div></div>
          <div className="card"><div className="label">Capacidade / dia</div><div className="metric">{dailyCapacity}</div><div className="muted">máximo planejado</div></div>
          <div className="card"><div className="label">Hoje</div><div className="metric">{todayRough}</div><div className="muted">estimativa antes da agenda</div></div>
          <div className="card"><div className="label">Dias</div><div className="metric">{roughDays || "—"}</div><div className="muted">estimativa mínima</div></div>
        </div>

        <div className="field" style={{ marginTop: 16 }}>
          <label>Nome da operação</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={selectedGroup ? "Add em " + (selectedGroup.name || "grupo") : "Ex.: Lista clientes outubro"} />
        </div>

        <label className="card" style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 14, marginTop: 14, cursor: "pointer" }}>
          <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <strong>Contatos autorizados</strong>
            <div className="muted" style={{ marginTop: 3 }}>
              Confirmo que estes contatos autorizaram a inclusão neste grupo.
            </div>
          </span>
        </label>

        <button
          className="btn primary"
          type="submit"
          disabled={busy === "create" || !leads.length || !senderIds.length || !groupId || !authorized}
          style={{ marginTop: 14 }}
        >
          {busy === "create" ? "Montando fila..." : "Iniciar fila"}
        </button>
      </form>

      {lastPlan.length ? (
        <div className="card" style={{ padding: 18, marginBottom: 18 }}>
          <div className="section-title">Planejamento gerado</div>
          <div className="toolbar" style={{ marginTop: 10 }}>
            {lastPlan.map((item) => <span className="badge ok" key={item.date}>{item.date}: {item.total} adições</span>)}
          </div>
        </div>
      ) : null}

      <div className="section">
        <div className="section-title">Filas</div>
        <div className="muted" style={{ marginTop: 4, marginBottom: 12 }}>
          Atualiza automaticamente a cada 10 segundos.
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          {campaigns.map((campaign) => {
            const completed = Number(campaign.counts?.added || 0);
            const failed = Number(campaign.counts?.failed || 0);
            const pending = Number(campaign.counts?.queued || 0) + Number(campaign.counts?.processing || 0);
            const progress = campaign.total_leads
              ? Math.min(100, Math.round(((completed + failed) / campaign.total_leads) * 100))
              : 0;

            return (
              <div className="card" style={{ padding: 18 }} key={campaign.id}>
                <div className="row" style={{ justifyContent: "space-between", gap: 14, alignItems: "flex-start" }}>
                  <div>
                    <div className="row" style={{ gap: 8 }}>
                      <h3 style={{ margin: 0 }}>{campaign.name}</h3>
                      <span className={"badge " + statusClass(campaign.status)}>{statusLabel(campaign.status)}</span>
                    </div>
                    <div className="muted" style={{ marginTop: 5 }}>
                      {(campaign.group_name || campaign.group_external_id) + " • " + (campaign.sender_instance_ids?.length || 0) + " conexões • " + campaign.daily_limit_per_sender + "/dia por conexão • " + campaign.interval_minutes + " min"}
                    </div>
                  </div>

                  <div className="toolbar">
                    {campaign.status === "active" ? (
                      <button className="btn secondary" disabled={busy === "pause:" + campaign.id} onClick={() => campaignAction(campaign, "pause")}>
                        Pausar
                      </button>
                    ) : null}
                    {campaign.status === "paused" ? (
                      <button className="btn" disabled={busy === "resume:" + campaign.id} onClick={() => campaignAction(campaign, "resume")}>
                        Continuar
                      </button>
                    ) : null}
                    {["active", "paused"].includes(campaign.status) ? (
                      <button className="btn danger-btn" disabled={busy === "cancel:" + campaign.id} onClick={() => campaignAction(campaign, "cancel")}>
                        Cancelar
                      </button>
                    ) : null}
                  </div>
                </div>

                <div style={{ marginTop: 12, height: 7, borderRadius: 99, background: "rgba(255,255,255,.08)", overflow: "hidden" }}>
                  <div style={{ width: progress + "%", height: "100%", background: "#e7b34e" }} />
                </div>

                <div className="instance-summary-grid" style={{ marginTop: 12 }}>
                  <div className="card"><div className="label">Total</div><div className="metric">{campaign.total_leads}</div></div>
                  <div className="card"><div className="label">Adicionados</div><div className="metric">{completed}</div></div>
                  <div className="card"><div className="label">Pendentes</div><div className="metric">{pending}</div></div>
                  <div className="card"><div className="label">Falhas</div><div className="metric">{failed}</div></div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 10, marginTop: 12 }}>
                  <div className="card" style={{ padding: 12 }}>
                    <div className="label">Próxima ação</div>
                    <div style={{ marginTop: 5, fontWeight: 700 }}>
                      {campaign.next_job
                        ? (campaign.next_job.lead_name || campaign.next_job.phone) + " • " + formatDateTime(campaign.next_job.scheduled_at)
                        : "Nenhuma ação pendente"}
                    </div>
                  </div>
                  <div className="card" style={{ padding: 12 }}>
                    <div className="label">Previsão de término</div>
                    <div style={{ marginTop: 5, fontWeight: 700 }}>{formatDateTime(campaign.estimated_finish_at)}</div>
                  </div>
                </div>

                {campaign.last_errors?.length ? (
                  <details style={{ marginTop: 12 }}>
                    <summary style={{ cursor: "pointer" }}>Últimos erros ({campaign.last_errors.length})</summary>
                    <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                      {campaign.last_errors.map((item) => (
                        <div className="muted" key={item.id}>
                          {(item.lead_name || item.phone) + ": " + item.error_message}
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            );
          })}

          {!campaigns.length ? <div className="card empty-state"><div className="muted">Nenhuma fila criada ainda.</div></div> : null}
        </div>
      </div>
    </>
  );
}
