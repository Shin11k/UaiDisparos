import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSupabaseSession } from "@/lib/supabase/session";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    return [value.message, value.details, value.hint, value.code]
      .filter(Boolean)
      .map(String)
      .join(" | ");
  }
  return String(error || "Erro desconhecido.");
}

export async function GET() {
  const h = headers();
  const userId = h.get("x-uai-user-id");
  const accountId = h.get("x-uai-account-id");
  const role = h.get("x-uai-role") || "client";

  if (!userId || !accountId) {
    return NextResponse.json({ ok: false, error: "Não autenticado." }, { status: 401 });
  }

  try {
    const supabase = getSupabaseSession();
    const [profileResult, accountResult, instancesResult] = await Promise.all([
      supabase.from("profiles").select("name,email,role,permissions").eq("user_id", userId).maybeSingle(),
      supabase.from("accounts").select("id,name,status,instance_limit,permissions").eq("id", accountId).maybeSingle(),
      supabase.from("instances").select("*", { count: "exact", head: true }).eq("account_id", accountId),
    ]);

    if (profileResult.error) throw profileResult.error;
    if (accountResult.error) throw accountResult.error;
    if (instancesResult.error) throw instancesResult.error;

    const profile = profileResult.data;
    const account = accountResult.data;
    const usedInstances = instancesResult.count ?? 0;

    if (!profile || !account) {
      return NextResponse.json(
        { ok: false, error: "Perfil ou conta não encontrado para a sessão atual." },
        { status: 404 },
      );
    }

    const accountPermissions = (account.permissions || {}) as Record<string, boolean>;
    const profilePermissions = profile.permissions && typeof profile.permissions === "object"
      ? profile.permissions as Record<string, boolean>
      : null;
    const effectivePermissions = role === "super_admin"
      ? accountPermissions
      : (profilePermissions ?? accountPermissions);

    return NextResponse.json({
      ok: true,
      user: {
        id: userId,
        name: profile.name,
        email: profile.email,
        role,
        permissions: effectivePermissions,
      },
      account: {
        ...account,
        permissions: effectivePermissions,
        account_permissions: accountPermissions,
        used_instances: usedInstances,
        available_instances: Math.max(0, Number(account.instance_limit || 0) - Number(usedInstances)),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: "Falha ao consultar a conta no PostgreSQL.", detail: errorMessage(error) },
      { status: 500 },
    );
  }
}
