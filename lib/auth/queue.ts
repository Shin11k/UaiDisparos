import { timingSafeEqual } from "node:crypto";

/** Protect cron / queue entrypoints. Requires a Worker secret, never a query parameter. */
export function authorizedQueueRequest(request: Request) {
  const key = process.env.UAI_QUEUE_SECRET;
  if (!key || key.length < 32) return false;
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return false;
  const provided = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(key);
  return provided.length === expected.length && timingSafeEqual(provided,expected);
}
