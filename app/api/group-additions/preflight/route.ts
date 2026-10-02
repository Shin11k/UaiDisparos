import { NextResponse } from "next/server";
import { getSupabaseSession } from "@/lib/supabase/session";
import { getTenantContext } from "@/lib/tenant";
import { validateInstanceGroupAdmin, type GroupAdditionInstance } from "@/lib/groupAdditions";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { accountId } = getTenantContext();
    const body = await req.json().catch(() => ({}));
    const groupId = String(body?.group_id || "");
    const senderIds: string[] = Array.from(new Set<string>(
      Array.isArray(body?.sender_instance_ids)
        ? body.sender_instance_ids.map((value: unknown) => String(value || "")).filter(Boolean)
        : [],
    ));

    if (!groupId || !senderIds.length) {
      return NextResponse.json(
        { ok: false, error: "Escolha o grupo e pelo menos uma conexão." },
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
    if (!group) return NextResponse.json({ ok: false, error: "Grupo não encontrado." }, { status: 404 });
    if (sendersError) throw sendersError;

    const validation: Array<{ id: string; name: string; phone: string | null; ok: boolean; reason: string }> = [];
    for (const sender of (senders || []) as GroupAdditionInstance[]) {
      const result = await validateInstanceGroupAdmin(sender, group.external_id);
      validation.push({
        id: sender.id,
        name: sender.name,
        phone: sender.phone,
        ...result,
      });
    }

    const missing = senderIds.filter((id) => !validation.some((item) => item.id === id));
    for (const id of missing) {
      validation.push({ id, name: "Conexão não encontrada", phone: null, ok: false, reason: "Conexão inválida." });
    }

    return NextResponse.json({
      ok: validation.every((item) => item.ok),
      group: { id: group.id, name: group.name, external_id: group.external_id },
      validation,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Erro ao validar conexões." },
      { status: 500 },
    );
  }
}
