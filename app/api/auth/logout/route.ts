import { NextRequest, NextResponse } from "next/server";
import { revokeSession, SESSION_COOKIE } from "@/lib/auth/local";

export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  // A sessão é revogada no banco; cookie removido mesmo se o banco estiver indisponível.
  try { if (token) await revokeSession(token); } catch {}
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true, secure: request.nextUrl.protocol === "https:",
    sameSite: "lax", path: "/", maxAge: 0,
  });
  return response;
}
