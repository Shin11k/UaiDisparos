import { NextRequest, NextResponse } from "next/server";
import { getSupabaseSession } from "@/lib/supabase/session";
import { getTenantContext, requireSuperAdmin, type PermissionKey } from "@/lib/tenant";
import { createCollaborator } from "@/lib/auth/users";

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

function collaboratorDefaults() {
  return normalizePermissions({ overview: true, instances: true });
}

async function snapshot(accountId?: string) {
  const supabase = getSupabaseSession();
  const [{ data: accounts, error: accountsError }, { data: profiles, error: profilesError }] = await Promise.all([
    supabase
      .from("accounts")
      .select("id,name,status,is_primary,permissions")
      .order("is_primary", { ascending: false })
      .order("created_at"),
    supabase
      .from("profiles")
      .select("user_id,account_id,name,email,role,permissions,created_at")
      .order("created_at"),
  ]);

  if (accountsError) throw accountsError;
  if (profilesError) throw profilesError;

  const selectedAccountId = accountId && accounts?.some((item) => item.id === accountId)
    ? accountId
    : (accounts?.find((item) => item.is_primary)?.id || accounts?.[0]?.id || null);

  return {
    accounts: accounts || [],
    selected_account_id: selectedAccountId,
    members: (profiles || []).filter((item) => !selectedAccountId || item.account_id === selectedAccountId),
  };
}

export async function GET(req: NextRequest) {
  try {
    requireSuperAdmin();
    const accountId = req.nextUrl.searchParams.get("account_id") || undefined;
    return NextResponse.json({ ok: true, ...(await snapshot(accountId)) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Acesso negado." },
      { status: 403 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    requireSuperAdmin();
    const context = getTenantContext();
    const body = await req.json();

    const name = String(body?.name || "").trim().slice(0, 100);
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");
    const accountId = String(body?.account_id || context.accountId);
    const permissions = body?.permissions
      ? normalizePermissions(body.permissions)
      : collaboratorDefaults();

    if (name.length < 2) {
      return NextResponse.json({ ok: false, error: "Informe o nome da colaboradora." }, { status: 400 });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return NextResponse.json({ ok: false, error: "Informe um e-mail válido." }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ ok: false, error: "A senha precisa ter pelo menos 8 caracteres." }, { status: 400 });
    }

    const supabase = getSupabaseSession();
    const { data: targetAccount, error: targetError } = await supabase
      .from("accounts")
      .select("id,name,status")
      .eq("id", accountId)
      .maybeSingle();

    if (targetError) throw targetError;
    if (!targetAccount) {
      return NextResponse.json({ ok: false, error: "Operação não encontrada." }, { status: 404 });
    }

    await createCollaborator({ accountId, name, email, password, permissions });

    return NextResponse.json({ ok: true, ...(await snapshot(accountId)) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Erro ao criar colaboradora." },
      { status: 500 },
    );
  }
}
