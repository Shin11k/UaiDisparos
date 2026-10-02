import { getSupabaseSession } from "@/lib/supabase/session";
import { requireTenantId } from "@/lib/tenant";
import GroupAdditionManager from "./GroupAdditionManager";

export const dynamic = "force-dynamic";

export default async function AddToGroupsPage() {
  const accountId = requireTenantId();
  const supabase = getSupabaseSession();

  const [{ data: instances }, { data: rawGroups }] = await Promise.all([
    supabase
      .from("instances")
      .select("id,name,phone,status,instance_role")
      .eq("account_id", accountId)
      .eq("status", "connected")
      .order("created_at", { ascending: true }),
    supabase
      .from("groups")
      .select("id,name,external_id,member_count,metadata")
      .eq("account_id", accountId)
      .order("name", { ascending: true }),
  ]);

  const byExternalId = new Map<string, any>();
  for (const group of rawGroups || []) {
    if (!group.external_id) continue;
    if (group.metadata?.is_parent === true || group.metadata?.is_community === true) continue;
    const current = byExternalId.get(group.external_id);
    if (!current || (!current.name && group.name)) byExternalId.set(group.external_id, group);
  }

  const groups = Array.from(byExternalId.values());

  return (
    <GroupAdditionManager
      initialInstances={(instances || []) as any}
      initialGroups={groups as any}
    />
  );
}
