// Execute LOCALMENTE no servidor após aplicar db/migrations/001_local_postgres_legacy_bridge.sql.
// Esse utilitário não envia senhas pela rede e não inclui credenciais no repositório.
import { Client } from "pg";
import bcrypt from "bcryptjs";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

function readSecret(question) {
  if (!process.stdin.isTTY) throw new Error("Execute em um terminal interativo.");
  return new Promise((resolve,reject)=>{
    process.stdout.write(question);
    let value="";
    const input=process.stdin;
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    const onKey=(char,key)=>{
      if (key?.ctrl && key.name==="c") {
        cleanup(); reject(new Error("Cancelado.")); return;
      }
      if (key?.name==="return" || key?.name==="enter") {
        cleanup(); process.stdout.write("\n"); resolve(value); return;
      }
      if (key?.name==="backspace") { value=value.slice(0,-1); return; }
      if (char && char >= " " && char !== "\x7f") value+=char;
    };
    function cleanup(){ input.off("keypress",onKey); input.setRawMode(false); }
    input.on("keypress",onKey);
  });
}

async function ask(question, fallback) {
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  const value=await new Promise(r=>rl.question(question,r));
  rl.close();
  return String(value||fallback).trim();
}

const email=(await ask("Email do administrador [uaidisparos@gmail.com]: ","uaidisparos@gmail.com")).toLowerCase();
if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("E-mail inválido.");
const name=await ask("Nome do administrador [Admin UAI]: ","Admin UAI");
const databasePassword=await readSecret("Senha do PostgreSQL (uai_app): ");
const adminPassword=await readSecret("NOVA senha do login UAI (mínimo 12 caracteres): ");
if (adminPassword.length < 12) throw new Error("Senha curta. Use no mínimo 12 caracteres.");
const confirm=await readSecret("Repita a NOVA senha do login UAI: ");
if (adminPassword!==confirm) throw new Error("Senhas não conferem.");

const client=new Client({
  host:"127.0.0.1",port:5432,database:"uaidisparos",
  user:"uai_app",password:databasePassword,
});
try {
  await client.connect();
  await client.query("BEGIN");
  const accountResult=await client.query(
    "SELECT id FROM public.accounts WHERE is_primary = true LIMIT 1 FOR UPDATE",
  );
  const accountId=accountResult.rows[0]?.id;
  if(!accountId) throw new Error("Execute primeiro a migração SQL de contas.");
  const existing=await client.query(
    "SELECT id FROM public.local_users WHERE lower(email)=lower($1) FOR UPDATE", [email],
  );
  const userId=existing.rows[0]?.id || randomUUID();
  const hash=await bcrypt.hash(adminPassword,12);
  if(existing.rows.length){
    await client.query(
      "UPDATE public.local_users SET password_hash=$1,account_id=$2,role='super_admin',active=true,updated_at=now() WHERE id=$3",
      [hash,accountId,userId],
    );
  }else{
    await client.query(
      "INSERT INTO public.local_users(id,account_id,email,password_hash,role) VALUES($1,$2,$3,$4,'super_admin')",
      [userId,accountId,email,hash],
    );
  }
  await client.query(
    `INSERT INTO public.profiles(user_id,account_id,name,email,role,permissions)
     VALUES($1,$2,$3,$4,'super_admin',NULL)
     ON CONFLICT (user_id) DO UPDATE SET
       account_id=EXCLUDED.account_id,name=EXCLUDED.name,
       email=EXCLUDED.email,role='super_admin',permissions=NULL,updated_at=now()`,
    [userId,accountId,name,email],
  );
  await client.query("COMMIT");
  console.log("Administrador UAI pronto no PostgreSQL. Nenhuma outra conta foi modificada.");
}catch(error){
  try{await client.query("ROLLBACK");}catch{}
  throw error;
}finally{
  await client.end();
}
