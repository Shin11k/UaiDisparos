import { NextRequest, NextResponse } from "next/server";
import { getSupabaseSession } from "@/lib/supabase/session";
import { removeCollaborator } from "@/lib/auth/users";
import { requireSuperAdmin, type PermissionKey } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const PERMISSION_KEYS: PermissionKey[] = [
  "overview", "instances", "groups", "leads", "campaigns",
  "group_broadcast", "private_broadcast", "operations", "notifications", "settings",
];

function normalizePermissions(value: unknown) {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result: Record<string, boolean> = {};
  for (const key of PERMISSION_KEYS) result[key] = source[key] === true;
  return result;
}

export async function PATCH(req: NextRequest, { params }: { params: { userId: string } }) {
  try {
    requireSuperAdmin();
    const userId = String(params.userId || "");
    const body = await req.json();
    const supabase = getSupabaseSession();

    const { data: current, error: currentError } = await supabase
      .from("profiles")
      .select("user_id,account_id,role")
      .eq("user_id", userId)
      .maybeSingle();

    if (currentError) throw currentError;
    if (!current) {
      return NextResponse.json({ ok: false, error: "Usuário não encontrado." }, { status: 404 });
    }
    if (current.role === "super_admin") {
      return NextResponse.json({ ok: false, error: "O super administrador não pode ser limitado por aqui." }, { status: 400 });
    }

    const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body?.name === "string" && body.name.trim()) {
      values.name = body.name.trim().slice(0, 100);
    }
    if (body?.permissions && typeof body.permissions === "object") {
      values.permissions = normalizePermissions(body.permissions);
    }

    const { data, error } = await supabase
      .from("profiles")
      .update(values)
      .eq("user_id", userId)
      .select("user_id,account_id,name,email,role,permissions,created_at")
      .single();

    if (error) throw error;
    return NextResponse.json({ ok: true, member: data });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Erro ao atualizar colaboradora." },
      { status: 500 },
    );
  }
}


export async function DELETE(_req: NextRequest, { params }: { params: { userId: string } }) {
  try {
    requireSuperAdmin();
    const userId = String(params.userId || "");
    const supabase = getSupabaseSession();

    const { data: current, error: currentError } = await supabase
      .from("profiles")
      .select("user_id,account_id,name,email,role")
      .eq("user_id", userId)
      .maybeSingle();

    if (currentError) throw currentError;
    if (!current) {
      return NextResponse.json({ ok: false, error: "Usuário não encontrado." }, { status: 404 });
    }
    if (current.role === "super_admin") {
      return NextResponse.json(
        { ok: false, error: "O super administrador principal não pode ser excluído." },
        { status: 400 },
      );
    }

    const [{ data: account, error: accountError }, { count: accountUsers, error: countError }] = await Promise.all([
      supabase
        .from("accounts")
        .select("id,is_primary,name")
        .eq("id", current.account_id)
        .maybeSingle(),
      supabase
        .from("profiles")
        .select("*", { count: "exact", head: true })
        .eq("account_id", current.account_id),
    ]);

    if (accountError) throw accountError;
    if (countError) throw countError;

    if (account && !account.is_primary && Number(accountUsers || 0) <= 1) {
      return NextResponse.json(
        {
          ok: false,
          error: "Esse é o único usuário dessa conta. Suspenda ou gerencie a conta pelo painel de clientes em vez de deixá-la sem acesso.",
        },
        { status: 400 },
      );
    }

    await removeCollaborator(userId);

    return NextResponse.json({
      ok: true,
      deleted_user_id: userId,
      deleted_email: current.email,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Erro ao excluir usuário." },
      { status: 500 },
    );
  }
}
