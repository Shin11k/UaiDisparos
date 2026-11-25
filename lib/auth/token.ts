/**
 * Short-lived HMAC-signed session claims, safe for Next Middleware (Web Crypto only).
 * Authoritative account data and revocable sessions remain in PostgreSQL.
 * Requires UAI_AUTH_SECRET (>=32 characters) in Cloudflare Worker secrets.
 */
export type AuthClaims = {
  userId: string;
  accountId: string;
  role: "super_admin" | "admin" | "client";
  permissions: Record<string, boolean>;
  accountStatus: string;
  exp: number;
  nonce: string;
};

const encoder = new TextEncoder();
const cookieParts = 2;
const maxTokenLength = 8192;

function secret() {
  const key = process.env.UAI_AUTH_SECRET;
  if (!key || key.length < 32) throw new Error("UAI_AUTH_SECRET ausente ou fraco.");
  return key;
}
async function hmacKey() {
  return crypto.subtle.importKey("raw", encoder.encode(secret()), {
    name: "HMAC", hash: "SHA-256",
  }, false, ["sign", "verify"]);
}
function encode(bytes: Uint8Array) {
  let raw = "";
  for (const n of bytes) raw += String.fromCharCode(n);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function decode(value: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Token inválido.");
  const input = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(input.padEnd(Math.ceil(input.length / 4) * 4, "=")), c=>c.charCodeAt(0));
}

export async function signSession(claims: Omit<AuthClaims, "exp" | "nonce">) {
  const expiresAt = new Date(Date.now() + 30 * 60_000);
  const nonce = encode(crypto.getRandomValues(new Uint8Array(16)));
  const value: AuthClaims = { ...claims, exp: Math.floor(expiresAt.getTime() / 1000), nonce };
  const body = encode(encoder.encode(JSON.stringify(value)));
  const digest = await crypto.subtle.sign("HMAC", await hmacKey(), encoder.encode(body));
  return { token: body + "." + encode(new Uint8Array(digest)), expiresAt };
}

export async function verifySession(token: string | undefined): Promise<AuthClaims | null> {
  if (!token || token.length > maxTokenLength) return null;
  const pieces = token.split(".");
  if (pieces.length !== cookieParts) return null;
  try {
    const [body,mac] = pieces;
    const valid = await crypto.subtle.verify(
      "HMAC", await hmacKey(), decode(mac), encoder.encode(body),
    );
    if (!valid) return null;
    const data = JSON.parse(new TextDecoder().decode(decode(body))) as AuthClaims;
    if (!data || typeof data !== "object" ||
        typeof data.userId !== "string" || typeof data.accountId !== "string" ||
        !["super_admin","admin","client"].includes(data.role) ||
        !data.permissions || typeof data.permissions !== "object" ||
        !Number.isSafeInteger(data.exp) || data.exp < Math.floor(Date.now()/1000)) return null;
    return data;
  } catch {
    return null;
  }
}
