"use client";

import { LogOut } from "lucide-react";
import { useState } from "react";

export default function LogoutButton() {
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }); }
    finally { window.location.href = "/login"; }
  }
  return (
    <button type="button" className="uai-logout-button" onClick={logout} disabled={busy}>
      <LogOut size={15} /><span>{busy ? "Saindo..." : "Sair"}</span>
    </button>
  );
}
