import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "@/lib/supabase/config";

type PermissionKey =
  | "overview" | "instances" | "groups" | "leads" | "campaigns"
  | "group_broadcast" | "private_broadcast" | "operations" | "notifications" | "settings";

type SupabaseCookieOptions = {
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: boolean | "lax" | "strict" | "none";
  secure?: boolean;
  priority?: "low" | "medium" | "high";
  partitioned?: boolean;
};

type SupabaseCookieToSet = {
  name: string;
  value: string;
  options?: SupabaseCookieOptions;
};

const AUTH_PAGES = ["/login", "/cadastro"];
const PASS_THROUGH_PAGES = ["/sem-acesso", "/conta-bloqueada"];
const PUBLIC_API_PREFIXES = [
  "/api/health",
  "/api/webhooks/uazapi",
  "/api/jobs/process",
  "/api/private-jobs/process",
  "/api/notifications/process",
];

const permissionLandingOrder: [PermissionKey, string][] = [
  ["overview", "/"],
  ["instances", "/instancias"],
  ["groups", "/grupos"],
  ["leads", "/leads"],
  ["campaigns", "/campanhas"],
  ["group_broadcast", "/disparos"],
  ["private_broadcast", "/disparos/privado"],
  ["operations", "/operacoes"],
  ["notifications", "/notificacoes"],
  ["settings", "/configuracoes"],
];

function permissionForPath(pathname: string): PermissionKey | "admin" | null {
  if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) return "admin";
  if (pathname.startsWith("/disparos/adicionar-grupos") || pathname.startsWith("/api/group-additions")) return "group_broadcast";
  if (pathname.startsWith("/disparos/privado") || pathname.startsWith("/api/private-broadcasts")) return "private_broadcast";
  if (pathname === "/disparos" || pathname.startsWith("/api/automations")) return "group_broadcast";
  if (pathname.startsWith("/instancias") || pathname.startsWith("/api/uazapi/instances") || pathname.startsWith("/api/uazapi/check-instance-statuses")) return "instances";
  if (pathname.startsWith("/grupos") || pathname.startsWith("/api/groups") || pathname.startsWith("/api/uazapi/groups") || pathname.startsWith("/api/uazapi/sync-groups") || pathname.startsWith("/api/uazapi/sync-all-monitors")) return "groups";
  if (pathname.startsWith("/leads")) return "leads";
  if (pathname.startsWith("/campanhas") || pathname.startsWith("/api/campaigns")) return "campaigns";
  if (pathname.startsWith("/operacoes") || pathname.startsWith("/logs")) return "operations";
  if (pathname.startsWith("/notificacoes") || pathname.startsWith("/api/notifications/settings")) return "notifications";
  if (pathname.startsWith("/configuracoes")) return "settings";
  if (pathname.startsWith("/api/uazapi/send")) return "group_broadcast";
  if (pathname === "/") return "overview";
  return null;
}

function firstAllowedPath(permissions: Record<string, boolean>) {
  for (const [key, path] of permissionLandingOrder) {
    if (permissions[key] === true) return path;
  }
  return "/sem-acesso";
}

function copyCookies(source: NextResponse, target: NextResponse) {
  for (const cookie of source.cookies.getAll()) target.cookies.set(cookie);
  return target;
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isApi = pathname.startsWith("/api/");
  const isAuthPage = AUTH_PAGES.some((path) => pathname === path || pathname.startsWith(path + "/"));
  const isPassThrough = PASS_THROUGH_PAGES.some((path) => pathname === path || pathname.startsWith(path + "/"));
  const isPublicApi = PUBLIC_API_PREFIXES.some((path) => pathname === path || pathname.startsWith(path + "/"));
  if (isPublicApi) return NextResponse.next();

  const url = SUPABASE_URL;
  const anon = SUPABASE_PUBLISHABLE_KEY;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete("x-uai-user-id");
  requestHeaders.delete("x-uai-account-id");
  requestHeaders.delete("x-uai-role");

  let response = NextResponse.next({ request: { headers: requestHeaders } });
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() { return request.cookies.getAll(); },
      setAll(cookiesToSet: SupabaseCookieToSet[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request: { headers: requestHeaders } });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    if (isAuthPage) return response;
    if (isApi) return copyCookies(response, NextResponse.json({ ok: false, error: "Não autenticado." }, { status: 401 }));
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return copyCookies(response, NextResponse.redirect(loginUrl));
  }

  const { data: profile } = await supabase.from("profiles")
    .select("user_id,account_id,name,email,role,permissions").eq("user_id", user.id).maybeSingle();

  if (!profile) {
    if (isPassThrough) return response;
    if (isApi) return copyCookies(response, NextResponse.json({ ok: false, error: "Perfil da conta não encontrado." }, { status: 403 }));
    const blocked = request.nextUrl.clone();
    blocked.pathname = "/conta-bloqueada";
    blocked.searchParams.set("motivo", "perfil");
    return copyCookies(response, NextResponse.redirect(blocked));
  }

  const { data: account } = await supabase.from("accounts")
    .select("id,name,status,instance_limit,permissions").eq("id", profile.account_id).maybeSingle();

  if (!account) {
    if (isPassThrough) return response;
    if (isApi) return copyCookies(response, NextResponse.json({ ok: false, error: "Conta não encontrada." }, { status: 403 }));
    const blocked = request.nextUrl.clone();
    blocked.pathname = "/conta-bloqueada";
    blocked.searchParams.set("motivo", "conta");
    return copyCookies(response, NextResponse.redirect(blocked));
  }

  const role = String(profile.role || "client");
  const accountPermissions = (account.permissions || {}) as Record<string, boolean>;
  const profilePermissions = profile.permissions && typeof profile.permissions === "object"
    ? profile.permissions as Record<string, boolean>
    : null;
  const permissions = profilePermissions ?? accountPermissions;
  const isSuperAdmin = role === "super_admin";

  if (isAuthPage) {
    const home = request.nextUrl.clone();
    home.pathname = isSuperAdmin ? "/" : firstAllowedPath(permissions);
    home.search = "";
    return copyCookies(response, NextResponse.redirect(home));
  }

  if (account.status !== "active" && !isSuperAdmin && !isPassThrough) {
    if (isApi) return copyCookies(response, NextResponse.json({ ok: false, error: "Conta suspensa." }, { status: 403 }));
    const blocked = request.nextUrl.clone();
    blocked.pathname = "/conta-bloqueada";
    blocked.searchParams.set("motivo", "suspensa");
    return copyCookies(response, NextResponse.redirect(blocked));
  }

  const required = permissionForPath(pathname);

  if (required === "admin" && !isSuperAdmin) {
    if (isApi) return copyCookies(response, NextResponse.json({ ok: false, error: "Acesso administrativo necessário." }, { status: 403 }));
    const denied = request.nextUrl.clone();
    denied.pathname = "/sem-acesso";
    denied.searchParams.set("rota", "admin");
    return copyCookies(response, NextResponse.redirect(denied));
  }

  if (required && required !== "admin" && !isSuperAdmin && permissions[required] !== true) {
    if (!isApi && pathname === "/") {
      const landing = firstAllowedPath(permissions);
      if (landing !== "/sem-acesso") {
        const destination = request.nextUrl.clone();
        destination.pathname = landing;
        destination.search = "";
        return copyCookies(response, NextResponse.redirect(destination));
      }
    }

    if (isApi) return copyCookies(response, NextResponse.json({ ok: false, error: "Módulo bloqueado para esta conta." }, { status: 403 }));
    const denied = request.nextUrl.clone();
    denied.pathname = "/sem-acesso";
    denied.searchParams.set("rota", required);
    return copyCookies(response, NextResponse.redirect(denied));
  }

  requestHeaders.set("x-uai-user-id", user.id);
  requestHeaders.set("x-uai-account-id", String(profile.account_id));
  requestHeaders.set("x-uai-role", role);

  const finalResponse = NextResponse.next({ request: { headers: requestHeaders } });
  return copyCookies(response, finalResponse);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
