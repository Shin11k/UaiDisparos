import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { queryPostgres } from "@/lib/postgres/server";

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
  const accountId=randomUUID(), userId=randomUUID();
  // Data-modifying CTEs make all three inserts atomic in one SQL statement.
  const result=await queryPostgres(
    `WITH account_row AS (
       INSERT INTO public.accounts(id,name,status,is_primary,instance_limit,permissions)
       VALUES($1,$2,'active',false,$3,$4::jsonb) RETURNING id
     ), user_row AS (
       INSERT INTO public.local_users(id,account_id,email,password_hash,role)
       SELECT $5,a.id,$6,$7,'client' FROM account_row a
       RETURNING id,account_id
     )
     INSERT INTO public.profiles(user_id,account_id,name,email,role,permissions)
     SELECT u.id,u.account_id,$2,$6,'client',NULL FROM user_row u
     RETURNING user_id`,
    [accountId,params.name,params.instanceLimit,JSON.stringify(params.permissions),userId,email,hash],
  );
  if(result.rowCount !== 1) throw new Error("Falha ao criar conta.");
  return {accountId,userId};
}

export async function createCollaborator(params:{
  accountId:string; name:string; email:string; password:string; permissions:PermissionSet;
}) {
  const email=normalizeEmail(params.email);
  const hash=await hashPassword(params.password);
  const userId=randomUUID();
  const result=await queryPostgres(
    `WITH user_row AS (
       INSERT INTO public.local_users(id,account_id,email,password_hash,role)
       SELECT $1,a.id,$3,$4,'client' FROM public.accounts a
       WHERE a.id=$2 AND a.status='active'
       RETURNING id,account_id
     )
     INSERT INTO public.profiles(user_id,account_id,name,email,role,permissions)
     SELECT u.id,u.account_id,$5,$3,'client',$6::jsonb FROM user_row u
     RETURNING user_id`,
    [userId,params.accountId,email,hash,params.name,JSON.stringify(params.permissions)],
  );
  if(result.rowCount !== 1) throw new Error("Conta inválida ou suspensa.");
  return {userId};
}

export async function removeCollaborator(userId:string) {
  const result=await queryPostgres(
    "DELETE FROM public.local_users WHERE id=$1 AND role <> 'super_admin' RETURNING id",
    [userId],
  );
  if(!result.rowCount) throw new Error("Colaborador não encontrado ou protegido.");
  return result.rows[0].id as string;
}
