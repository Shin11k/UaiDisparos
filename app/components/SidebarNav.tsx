"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Activity, Bell, KeyRound, LayoutDashboard, Megaphone, MessageCircle, Send, Smartphone, UserPlus, UserRound, Users } from "lucide-react";

type PermissionKey =
  | "overview" | "instances" | "groups" | "leads" | "campaigns"
  | "group_broadcast" | "private_broadcast" | "operations" | "notifications" | "settings";

const nav:[string,string,any,PermissionKey][] = [
  ["/","Visão geral",LayoutDashboard,"overview"],
  ["/instancias","Instâncias",Smartphone,"instances"],
  ["/grupos","Grupos",Users,"groups"],
  ["/leads","Leads",UserRound,"leads"],
  ["/campanhas","Campanhas",Megaphone,"campaigns"],
  ["/disparos","Disparo em grupo",Send,"group_broadcast"],
  ["/disparos/privado","Disparo privado",MessageCircle,"private_broadcast"],
  ["/disparos/adicionar-grupos","Add em grupos",UserPlus,"group_broadcast"],
  ["/operacoes","Operações",Activity,"operations"],
  ["/notificacoes","Notificações",Bell,"notifications"],
];

export default function SidebarNav(){
  const pathname = usePathname();
  const [permissions,setPermissions] = useState<Record<string,boolean>>({});
  const [role,setRole] = useState("");
  const [loaded,setLoaded] = useState(false);

  useEffect(() => {
    let active = true;

    fetch("/api/me",{cache:"no-store"})
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!active) return;

        if (body?.ok) {
          setPermissions(body.account?.permissions || {});
          setRole(body.user?.role || "");
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoaded(true);
      });

    return () => { active = false; };
  }, [pathname]);

  const superAdmin = role === "super_admin";

  const visibleNav = useMemo(() => {
    // Nunca deixa a lateral vazia enquanto /api/me carrega ou se a rota de sessão falhar.
    // O middleware continua sendo a autoridade final de acesso.
    if (!loaded || superAdmin) return nav;
    return nav.filter(([, , , key]) => permissions[key] === true);
  }, [loaded, superAdmin, permissions]);

  return (
    <nav className="nav">
      {visibleNav.map(([href,label,Icon]) => {
        const active = href === "/"
          ? pathname === "/"
          : href === "/disparos"
            ? pathname === "/disparos"
            : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link key={href} href={href} className={active ? "active" : ""}>
            <span className="nav-icon"><Icon size={17} strokeWidth={1.8}/></span>
            <span>{label}</span>
            {active ? <span className="nav-active-dot"/> : null}
          </Link>
        );
      })}

      {superAdmin ? (
        <Link href="/admin/clientes" className={pathname.startsWith("/admin") ? "active" : ""}>
          <span className="nav-icon"><KeyRound size={17} strokeWidth={1.8}/></span>
          <span>Clientes & acessos</span>
          {pathname.startsWith("/admin") ? <span className="nav-active-dot"/> : null}
        </Link>
      ) : null}
    </nav>
  );
}
