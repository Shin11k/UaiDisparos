import { NextRequest, NextResponse } from "next/server";
import { authenticatePassword, createSession, SESSION_COOKIE } from "@/lib/auth/local";

export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || password.length < 8 || password.length > 1024) {
    return NextResponse.json({ ok: false, error: "Credenciais inválidas." }, { status: 401 });
  }
  try {
    const user = await authenticatePassword(email, password);
    if (!user) {
      return NextResponse.json({ ok: false, error: "E-mail ou senha inválidos." }, { status: 401 });
    }
    const { token, expiresAt } = await createSession(user);
    const response = NextResponse.json({ ok: true, user: { name: user.name, role: user.role } });
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: "lax", secure: request.nextUrl.protocol === "https:",
      path: "/", expires: expiresAt,
    });
    return response;
  } catch {
    return NextResponse.json({ ok: false, error: "Serviço de autenticação indisponível." }, { status: 503 });
  }
}
