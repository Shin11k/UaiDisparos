import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Pool } from "pg";

const host = process.env.UAI_GATEWAY_HOST || "127.0.0.1";
const port = Number(process.env.UAI_GATEWAY_PORT || "3107");
const accessToken = process.env.UAI_GATEWAY_TOKEN || "";

if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  throw new Error("O gateway só pode escutar localhost. Use Cloudflare Tunnel para acesso externo.");
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("UAI_GATEWAY_PORT inválida.");
}
if (accessToken.length < 32 || accessToken.includes("SUBSTITUIR")) {
  throw new Error("Defina UAI_GATEWAY_TOKEN forte no arquivo .env do servidor.");
}

const required = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"];
for (const key of required) {
  if (!process.env[key] || String(process.env[key]).startsWith("SUBSTITUIR")) {
    throw new Error(`Configure ${key} no .env do servidor.`);
  }
}

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: true } : false,
  max: 5,
  idleTimeoutMillis: 15_000,
  connectionTimeoutMillis: 5_000,
  query_timeout: 8_000,
});

function authorized(request) {
  const header = String(request.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return false;

  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(accessToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sendJson(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  if (!authorized(request)) {
    sendJson(response, 401, { ok: false, error: "Não autorizado." });
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    try {
      const result = await pool.query("select 1 as healthy, current_database() as database");
      sendJson(response, 200, {
        ok: true,
        database: result.rows[0].database,
        postgres: true,
        stage: "conexao",
      });
    } catch {
      sendJson(response, 503, { ok: false, postgres: false, error: "Banco indisponível." });
    }
    return;
  }
  sendJson(response, 404, { ok: false, error: "Rota não encontrada." });
});

server.listen(port, host, () => {
  console.log(`UAI SQL Gateway ouvindo em http://${host}:${port}`);
});

process.on("SIGTERM", async () => {
  server.close();
  await pool.end();
});
process.on("SIGINT", async () => {
  server.close();
  await pool.end();
});
