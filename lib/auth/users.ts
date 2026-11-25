import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { withPostgresTransaction } from "@/lib/postgres/server";

type PermissionSet = Record<string,boolean>;

function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) throw new Error("E-mail inválido.");
  return email;
}
async function hashPassword(password: string) {
  if (password.length < 8 || password.length > 1024) throw new Error("Senha inválida.");
  return bcrypt.hash(password,12);
}

export async function createCustomerAccount(params: {
  name:string; email:string; password:string; instanceLimit:number; permissions:PermissionSet;
}) {
  const email=normalizeEmail(params.email);
  const hash=await hashPassword(params.password);
  return withPostgresTransaction(async client=>{
    const accountId=randomUUID(), userId=randomUUID();
    await client.query(
      "INSERT INTO public.accounts(id,name,status,is_primary,instance_limit,permissions) VALUES ($1,$2,'active',false,$3,$4::jsonb)",
      [accountId,params.name,params.instanceLimit,JSON.stringify(params.permissions)],
    );
    await client.query(
      "INSERT INTO public.local_users(id,account_id,email,password_hash,role) VALUES($1,$2,$3,$4,'client')",
      [userId,accountId,email,hash],
    );
    await client.query(
      "INSERT INTO public.profiles(user_id,account_id,name,email,role,permissions) VALUES($1,$2,$3,$4,'client',NULL)",
      [userId,accountId,params.name,email],
    );
    return {accountId,userId};
  });
}

export async function createCollaborator(params:{
  accountId:string; name:string; email:string; password:string; permissions:PermissionSet;
}) {
  const email=normalizeEmail(params.email);
  const hash=await hashPassword(params.password);
  return withPostgresTransaction(async client=>{
    const found=await client.query("SELECT id FROM public.accounts WHERE id=$1 AND status='active'",[params.accountId]);
    if(!found.rows.length) throw new Error("Conta inválida ou suspensa.");
    const userId=randomUUID();
    await client.query(
      "INSERT INTO public.local_users(id,account_id,email,password_hash,role) VALUES($1,$2,$3,$4,'client')",
      [userId,params.accountId,email,hash],
    );
    await client.query(
      "INSERT INTO public.profiles(user_id,account_id,name,email,role,permissions) VALUES($1,$2,$3,$4,'client',$5::jsonb)",
      [userId,params.accountId,params.name,email,JSON.stringify(params.permissions)],
    );
    return {userId};
  });
}

export async function removeCollaborator(userId:string) {
  return withPostgresTransaction(async client=>{
    const result=await client.query(
      "DELETE FROM public.local_users WHERE id=$1 AND role <> 'super_admin' RETURNING id",
      [userId],
    );
    if(!result.rowCount) throw new Error("Colaborador não encontrado ou protegido.");
    return result.rows[0].id as string;
  });
}
