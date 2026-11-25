import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/auth/token";

type PermissionKey =
  | "overview" | "instances" | "groups" | "leads" | "campaigns"
  | "group_broadcast" | "private_broadcast" | "operations" | "notifications" | "settings";

const AUTH_PAGES = ["/login", "/cadastro"];
const PASS_THROUGH_PAGES = ["/sem-acesso", "/conta-bloqueada"];
const PUBLIC_API_PREFIXES = [
  "/api/health",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/webhooks/uazapi",
  // Queue processors need their own secret validation before production cutover.
  "/api/jobs/process",
  "/api/private-jobs/process",
  "/api/notifications/process",
];
const landingOrder: [PermissionKey, string][] = [
  ["overview", "/"], ["instances", "/instancias"], ["groups", "/grupos"],
  ["leads", "/leads"], ["campaigns", "/campanhas"],
  ["group_broadcast", "/disparos"], ["private_broadcast", "/disparos/privado"],
  ["operations", "/operacoes"], ["notifications", "/notificacoes"],
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

function firstAllowed(permissions: Record<string,boolean>) {
  for (const [key,path] of landingOrder) {
    if (permissions[key] === true) return path;
  }
  return "/sem-acesso";
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isApi = pathname.startsWith("/api/");
  const isAuthPage = AUTH_PAGES.some(path=>pathname===path || pathname.startsWith(path+"/"));
  const isPassThrough = PASS_THROUGH_PAGES.some(path=>pathname===path || pathname.startsWith(path+"/"));
  const publicApi = PUBLIC_API_PREFIXES.some(path=>pathname===path || pathname.startsWith(path+"/"));
  if (publicApi) return NextResponse.next();

  const cleanHeaders = new Headers(request.headers);
  cleanHeaders.delete("x-uai-user-id");
  cleanHeaders.delete("x-uai-account-id");
  cleanHeaders.delete("x-uai-role");

  const cookie = request.cookies.get("uai_session")?.value;
  const session = await verifySession(cookie);
  if (!session) {
    if (isAuthPage) return NextResponse.next({request:{headers:cleanHeaders}});
    if (isApi) return NextResponse.json({ok:false,error:"Não autenticado."},{status:401});
    const destination = request.nextUrl.clone();
    destination.pathname = "/login";
    destination.searchParams.set("next",pathname);
    return NextResponse.redirect(destination);
  }
  if (isAuthPage) {
    const destination = request.nextUrl.clone();
    destination.pathname = session.role === "super_admin" ? "/" : firstAllowed(session.permissions);
    destination.search = "";
    return NextResponse.redirect(destination);
  }
  if (session.accountStatus !== "active" && session.role !== "super_admin" && !isPassThrough) {
    if (isApi) return NextResponse.json({ok:false,error:"Conta suspensa."},{status:403});
    const destination = request.nextUrl.clone();
    destination.pathname = "/conta-bloqueada";
    destination.searchParams.set("motivo","suspensa");
    return NextResponse.redirect(destination);
  }

  const required = permissionForPath(pathname);
  if (required === "admin" && session.role !== "super_admin") {
    if (isApi) return NextResponse.json({ok:false,error:"Acesso administrativo necessário."},{status:403});
    const destination = request.nextUrl.clone();
    destination.pathname = "/sem-acesso";
    destination.searchParams.set("rota","admin");
    return NextResponse.redirect(destination);
  }
  if (required && required !== "admin" && session.role !== "super_admin" && session.permissions[required] !== true) {
    if (!isApi && pathname === "/") {
      const allowed = firstAllowed(session.permissions);
      if (allowed !== "/sem-acesso") {
        const destination = request.nextUrl.clone();
        destination.pathname = allowed;
        destination.search = "";
        return NextResponse.redirect(destination);
      }
    }
    if (isApi) return NextResponse.json({ok:false,error:"Módulo bloqueado."},{status:403});
    const destination = request.nextUrl.clone();
    destination.pathname = "/sem-acesso";
    destination.searchParams.set("rota",required);
    return NextResponse.redirect(destination);
  }
  cleanHeaders.set("x-uai-user-id",session.userId);
  cleanHeaders.set("x-uai-account-id",session.accountId);
  cleanHeaders.set("x-uai-role",session.role);
  return NextResponse.next({request:{headers:cleanHeaders}});
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
