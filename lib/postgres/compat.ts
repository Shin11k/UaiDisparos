import { headers } from "next/headers";
import { queryPostgres } from "./server";

type SqlFilter = { sql: string; values: unknown[] };
type Row = Record<string, unknown>;
type Operation = "select" | "insert" | "update" | "delete" | "upsert";
type SqlResult = { data: any[] | null; error: { code?: string; message: string } | null; count: number | null };

const TABLES = new Set([
  "accounts", "profiles", "system_settings", "local_users", "local_sessions",
  "instances", "groups", "leads", "campaigns", "group_automations", "jobs",
  "webhook_events", "suppression_list", "notification_outbox", "notification_settings",
  "private_broadcast_recipients", "private_broadcasts", "group_participant_snapshots",
  "group_addition_campaigns", "group_addition_jobs",
]);
const TENANT_TABLES = new Set([
  "accounts", "profiles",
  "instances", "groups", "leads", "campaigns", "group_automations", "jobs",
  "webhook_events", "suppression_list", "notification_outbox", "notification_settings",
  "private_broadcast_recipients", "private_broadcasts", "group_participant_snapshots",
  "group_addition_campaigns", "group_addition_jobs",
]);

function identifier(input: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(input)) throw new Error("Identificador SQL inválido.");
  return '"' + input.replace(/"/g, '""') + '"';
}
function selectList(input: string): string {
  if (input.trim() === "*") return "*";
  return input.split(",").map(x => identifier(x.trim())).join(", ");
}
function requestIdentity(): { accountId: string; role: string } {
  const h = headers();
  const userId = h.get("x-uai-user-id");
  const accountId = h.get("x-uai-account-id");
  const role = h.get("x-uai-role");
  if (!userId || !accountId) throw new Error("Sessão PostgreSQL ausente.");
  return { accountId, role: role || "client" };
}

function sqlError(error: unknown) {
  const value = error as { code?: string; message?: string };
  return { code: value?.code, message: value?.message || "Falha no banco de dados." };
}

/**
 * Transitional database query interface for existing Supabase-style calls.
 * Rejects unknown identifiers and nested PostgREST expressions instead of
 * executing user-supplied SQL. Remove after migrating all routes to typed SQL.
 */
export class PgQueryBuilder implements PromiseLike<SqlResult> {
  private action: Operation = "select";
  private projection = "*";
  private body: Row | Row[] | null = null;
  private conditions: SqlFilter[] = [];
  private ordering: string[] = [];
  private limitValue: number | null = null;
  private offsetValue: number | null = null;
  private exactCount = false;
  private headOnly = false;
  private singleRow = false;
  private maybe = false;
  private returning = false;
  private conflict = "id";

  constructor(private readonly table: string, private readonly elevated: boolean) {
    if (!TABLES.has(table)) throw new Error("Tabela não autorizada para o adaptador SQL.");
  }

  select(columns = "*", options?: { count?: "exact"; head?: boolean }) {
    this.projection = columns.trim();
    selectList(this.projection);
    this.exactCount = options?.count === "exact";
    this.headOnly = options?.head === true;
    this.returning = true;
    return this;
  }
  insert(value: Row | Row[]) { this.action = "insert"; this.body = value; this.returning = false; return this; }
  update(value: Row) { this.action = "update"; this.body = value; this.returning = false; return this; }
  delete() { this.action = "delete"; this.returning = false; return this; }
  upsert(value: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    if (options?.ignoreDuplicates) throw new Error("ignoreDuplicates não implementado.");
    this.action = "upsert"; this.body = value; this.returning = false;
    this.conflict = options?.onConflict || "id";
    return this;
  }
  private add(column: string, operator: string, value: unknown) {
    const col = identifier(column);
    if (operator === "is") {
      if (value !== null) throw new Error("Somente IS NULL é permitido.");
      this.conditions.push({ sql: col + " IS NULL", values: [] });
    } else if (operator === "is not") {
      if (value !== null) throw new Error("Somente IS NOT NULL é permitido.");
      this.conditions.push({ sql: col + " IS NOT NULL", values: [] });
    } else {
      this.conditions.push({ sql: col + " " + operator + " ?", values: [value] });
    }
    return this;
  }
  eq(c: string, v: unknown) { return this.add(c, v === null ? "is" : "=", v); }
  neq(c: string, v: unknown) { return this.add(c, v === null ? "is not" : "<>", v); }
  gt(c: string, v: unknown) { return this.add(c, ">", v); }
  gte(c: string, v: unknown) { return this.add(c, ">=", v); }
  lt(c: string, v: unknown) { return this.add(c, "<", v); }
  lte(c: string, v: unknown) { return this.add(c, "<=", v); }
  ilike(c: string, v: unknown) { return this.add(c, "ILIKE", v); }
  like(c: string, v: unknown) { return this.add(c, "LIKE", v); }
  is(c: string, v: unknown) { return this.add(c, "is", v); }
  not(c: string, op: string, v: unknown) {
    if (op === "is" && v === null) return this.add(c, "is not", null);
    if (op === "eq") return this.add(c, "<>", v);
    throw new Error("Operador NOT não suportado.");
  }
  in(c: string, values: unknown[]) {
    const col = identifier(c);
    if (!Array.isArray(values)) throw new Error("IN precisa de array.");
    this.conditions.push(values.length ? {sql: col + " = ANY(?)", values: [values]} : {sql: "FALSE", values: []});
    return this;
  }
  match(fields: Row) { for (const [key,val] of Object.entries(fields)) this.eq(key,val); return this; }
  or(expression: string) {
    // PostgREST syntax accepted: field.eq.value,field.lte.value,... .
    // This is parsed into bound parameters, never concatenated as SQL values.
    const clauses: string[] = []; const values: unknown[] = [];
    for (const entry of expression.split(",")) {
      const match = /^([a-z_][a-z0-9_]*)\.(eq|neq|gt|gte|lt|lte|is)\.(.*)$/i.exec(entry);
      if (!match) throw new Error("Filtro OR não suportado.");
      const [, col, op, raw] = match;
      if (op === "is" && raw === "null") {
        clauses.push(identifier(col) + " IS NULL"); continue;
      }
      const comparators: Record<string, string> = { eq:"=", neq:"<>", gt:">", gte:">=", lt:"<", lte:"<=" };
      const comparator = comparators[op];
      if (!comparator) throw new Error("Operador OR inválido.");
      clauses.push(identifier(col) + " " + comparator + " ?");
      values.push(raw);
    }
    if (clauses.length) this.conditions.push({sql:"(" + clauses.join(" OR ") + ")",values});
    return this;
  }
  order(c: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.ordering.push(identifier(c) + (options?.ascending === false ? " DESC" : " ASC") +
      (options?.nullsFirst === true ? " NULLS FIRST" : ""));
    return this;
  }
  limit(n: number) {
    this.limitValue = Math.min(10000, Math.max(0, Math.floor(n))); return this;
  }
  range(from: number, to: number) {
    this.offsetValue = Math.max(0, Math.floor(from));
    this.limitValue = Math.max(0, Math.floor(to - from + 1));
    return this;
  }
  async single(): Promise<{ data: any; error: SqlResult["error"]; count: number | null }> { this.singleRow = true; return this.execute() as any; }
  async maybeSingle(): Promise<{ data: any; error: SqlResult["error"]; count: number | null }> { this.singleRow = true; this.maybe = true; return this.execute() as any; }
  then<TResult1 = SqlResult, TResult2 = never>(
    onfulfilled?: ((value: SqlResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private scopedConditions(): SqlFilter[] {
    if (this.elevated || !TENANT_TABLES.has(this.table)) return [...this.conditions];
    const user = requestIdentity();
    if (user.role === "super_admin") return [...this.conditions];
    if (this.table === "accounts") return [...this.conditions, {sql:'"id" = ?',values:[user.accountId]}];
    return [...this.conditions, {sql:'"account_id" = ?',values:[user.accountId]}];
  }
  private bind(statement: string, values: unknown[]) {
    let pos = 0; return statement.replace(/\?/g, () => "$" + String(++pos));
  }
  private where(filters: SqlFilter[]): { clause: string; values: unknown[] } {
    const values: unknown[] = [];
    const parts = filters.map(f => { values.push(...f.values); return f.sql; });
    return { clause: parts.length ? " WHERE " + parts.join(" AND ") : "", values };
  }
  private withTenant(row: Row): Row {
    if (this.elevated || !TENANT_TABLES.has(this.table)) return row;
    const user = requestIdentity();
    if (user.role === "super_admin") return row;
    if (this.table === "accounts") throw new Error("Apenas super-administradores podem criar contas.");
    if (row.account_id !== undefined && row.account_id !== user.accountId)
      throw new Error("Conta de destino não autorizada.");
    return {...row,account_id:user.accountId};
  }

  private async execute(): Promise<SqlResult> {
    try {
      const table = "public." + identifier(this.table);
      const filters = this.scopedConditions();
      const w = this.where(filters);
      const projection = selectList(this.projection);
      const sort = this.ordering.length ? " ORDER BY " + this.ordering.join(", ") : "";
      const limit = this.limitValue === null ? "" : " LIMIT " + String(this.limitValue);
      const offset = this.offsetValue === null ? "" : " OFFSET " + String(this.offsetValue);
      let statement: string; let values: unknown[] = [];
      let count: number | null = null;

      if (this.action === "select") {
        if (this.exactCount) {
          const counted = await queryPostgres<{count: number}>(
            this.bind("SELECT COUNT(*)::int AS count FROM " + table + w.clause, w.values),
            w.values,
          );
          count = Number(counted.rows[0]?.count ?? 0);
        }
        if (this.headOnly) return {data:null,error:null,count};
        statement = "SELECT " + projection + " FROM " + table + w.clause + sort + limit + offset;
        values = w.values;
      } else if (this.action === "insert" || this.action === "upsert") {
        const items = (Array.isArray(this.body) ? this.body : [this.body]).filter(Boolean) as Row[];
        if (!items.length) return {data:[],error:null,count:0};
        const rows = items.map(item=>this.withTenant(item));
        const cols = Object.keys(rows[0]).sort();
        if (!cols.length || rows.some(row=>Object.keys(row).sort().join(",")!==cols.join(",")))
          throw new Error("Inserções em lote exigem as mesmas colunas.");
        const params: unknown[] = [];
        const tuples = rows.map(row=>"(" + cols.map(c=>{params.push(row[c]);return "?";}).join(",") + ")");
        const list = cols.map(identifier).join(",");
        statement = "INSERT INTO " + table + " (" + list + ") VALUES " + tuples.join(",");
        if (this.action === "upsert") {
          const keys = this.conflict.split(",").map(c=>identifier(c.trim()));
          if (keys.some(c=>!cols.map(identifier).includes(c))) throw new Error("Coluna de conflito ausente.");
          const conflictCols = keys.join(",");
          const updateCols = cols.filter(c=>!keys.includes(identifier(c)));
          statement += updateCols.length
            ? " ON CONFLICT (" + conflictCols + ") DO UPDATE SET " + updateCols.map(c=>identifier(c)+" = EXCLUDED."+identifier(c)).join(",")
            : " ON CONFLICT (" + conflictCols + ") DO NOTHING";
        }
        statement += this.returning ? " RETURNING " + projection : "";
        values = params;
      } else if (this.action === "update") {
        const valuesToWrite = {...(this.body || {})} as Row;
        if (!this.elevated && TENANT_TABLES.has(this.table) && "account_id" in valuesToWrite)
          throw new Error("Alteração de account_id bloqueada.");
        const cols = Object.keys(valuesToWrite).sort();
        if (!cols.length) throw new Error("UPDATE sem valores.");
        values = cols.map(c=>valuesToWrite[c]);
        statement = "UPDATE " + table + " SET " + cols.map(c=>identifier(c)+" = ?").join(",") +
          w.clause + (this.returning ? " RETURNING "+projection : "");
        values.push(...w.values);
      } else {
        statement = "DELETE FROM " + table + w.clause + (this.returning ? " RETURNING "+projection : "");
        values = w.values;
      }
      const results = await queryPostgres(this.bind(statement,values),values);
      const data = this.returning || this.action === "select" ? results.rows : null;
      if (this.singleRow) {
        if (results.rows.length !== 1 && !(this.maybe && results.rows.length === 0)) {
          return {data:null,error:{code:"PGRST116",message:"Resposta não possui exatamente uma linha."},count};
        }
        return {data:(results.rows[0] || null) as any,error:null,count};
      }
      return {data,error:null,count};
    } catch(error) {
      return {data:null,error:sqlError(error),count:null};
    }
  }
}

export function getPostgresSessionClient() {
  return { from(table: string) { return new PgQueryBuilder(table,false); } };
}
export function getPostgresAdminClient() {
  return { from(table: string) { return new PgQueryBuilder(table,true); } };
}
