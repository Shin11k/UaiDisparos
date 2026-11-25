import { createHash } from "node:crypto";
import { signSession } from "./token";
import bcrypt from "bcryptjs";
import { queryPostgres } from "@/lib/postgres/server";

export const SESSION_COOKIE = "uai_session";


export type LocalIdentity = {
  user_id: string;
  account_id: string;
  email: string;
  name: string;
  role: "super_admin" | "admin" | "client";
  permissions: Record<string, boolean> | null;
  account_permissions: Record<string, boolean>;
  account_status: string;
};

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function authenticatePassword(email: string, password: string): Promise<LocalIdentity | null> {
  const result = await queryPostgres<{
    user_id: string; account_id: string; email: string; password_hash: string;
    role: LocalIdentity["role"]; name: string; permissions: Record<string, boolean> | null;
    account_permissions: Record<string, boolean>; account_status: string;
  }>(
    `SELECT u.id AS user_id, u.account_id, u.email, u.password_hash,
            p.name, p.role, p.permissions,
            a.permissions AS account_permissions, a.status AS account_status
       FROM public.local_users u
       JOIN public.profiles p ON p.user_id = u.id
       JOIN public.accounts a ON a.id = u.account_id
      WHERE lower(u.email) = lower($1) AND u.active = true AND a.status = 'active'
      LIMIT 1`,
    [email],
  );
  const row = result.rows[0];
  // Run hash verification even when the email does not exist.
  const placeholder = "$2a$12$MgYQwFUz7OXLjzQPBczNYOoJ6xnHc1WeDbIK8w0PYl8xjVKoB8SZa";
  const good = await bcrypt.compare(password, row?.password_hash || placeholder);
  if (!row || !good) return null;
  const { password_hash: _ignored, ...identity } = row;
  return identity;
}

export async function createSession(user: LocalIdentity) {
  const {token,expiresAt} = await signSession({
    userId: user.user_id,
    accountId: user.account_id,
    role: user.role,
    accountStatus: user.account_status,
    permissions: user.role === "super_admin"
      ? user.account_permissions
      : (user.permissions ?? user.account_permissions),
  });
  await queryPostgres(
    "INSERT INTO public.local_sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)",
    [hashToken(token), user.user_id, expiresAt],
  );
  return { token, expiresAt };
}

export async function revokeSession(token: string) {
  if (!token || token.length > 1024) return;
  await queryPostgres(
    "UPDATE public.local_sessions SET revoked_at = now() WHERE token_hash = $1",
    [hashToken(token)],
  );
}

export async function getSessionIdentity(token: string): Promise<LocalIdentity | null> {
  if (!token || token.length > 1024) return null;
  const result = await queryPostgres<LocalIdentity>(
    `SELECT u.id AS user_id, u.account_id, u.email,
            p.name, p.role, p.permissions,
            a.permissions AS account_permissions, a.status AS account_status
       FROM public.local_sessions s
       JOIN public.local_users u ON u.id = s.user_id
       JOIN public.profiles p ON p.user_id = u.id
       JOIN public.accounts a ON a.id = u.account_id
      WHERE s.token_hash = $1 AND s.expires_at > now()
        AND s.revoked_at IS NULL AND u.active = true
      LIMIT 1`,
    [hashToken(token)],
  );
  return result.rows[0] || null;
}
