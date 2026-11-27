import { Client } from "pg";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const required = ["PGPASSWORD","UAI_ADMIN_EMAIL","UAI_ADMIN_PASSWORD"];
for (const key of required) {
  if (!process.env[key]) throw new Error(key + " não informado; cadastro interrompido.");
}
const email = process.env.UAI_ADMIN_EMAIL.trim().toLowerCase();
const password = process.env.UAI_ADMIN_PASSWORD;
const name = (process.env.UAI_ADMIN_NAME || "Administrador UAI").trim();
if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("E-mail do administrador inválido.");
if (password.length < 12) throw new Error("Senha do administrador precisa de 12 caracteres.");
const hash = await bcrypt.hash(password, 12);
const db = new Client({
  host: "127.0.0.1",
  port: 5432,
  database: "uaidisparos",
  user: "uai_app",
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 8000,
  query_timeout: 12000,
});
try {
  await db.connect();
  await db.query("BEGIN");
  const a = await db.query(
    "SELECT id FROM public.accounts WHERE is_primary = true ORDER BY created_at LIMIT 1 FOR UPDATE",
  );
  const accountId = a.rows[0]?.id;
  if (!accountId) throw new Error("Migração SQL não foi executada.");
  const u = await db.query(
    "SELECT id FROM public.local_users WHERE lower(email) = lower($1) FOR UPDATE",
    [email],
  );
  const userId = u.rows[0]?.id || randomUUID();
  if (u.rows.length) {
    await db.query(
      "UPDATE public.local_users SET account_id=$1,password_hash=$2,role='super_admin',active=true,updated_at=now() WHERE id=$3",
      [accountId, hash, userId],
    );
  } else {
    await db.query(
      "INSERT INTO public.local_users(id,account_id,email,password_hash,role) VALUES($1,$2,$3,$4,'super_admin')",
      [userId, accountId, email, hash],
    );
  }
  await db.query(
    `INSERT INTO public.profiles(user_id,account_id,name,email,role,permissions)
     VALUES($1,$2,$3,$4,'super_admin',NULL)
     ON CONFLICT (user_id) DO UPDATE SET
       account_id=EXCLUDED.account_id,name=EXCLUDED.name,
       email=EXCLUDED.email,role='super_admin',permissions=NULL,updated_at=now()`,
    [userId,accountId,name,email],
  );
  await db.query("COMMIT");
  console.log("Administrador criado/atualizado com sucesso no PostgreSQL.");
} catch (error) {
  try { await db.query("ROLLBACK"); } catch {}
  throw error;
} finally {
  await db.end();
}
