create table if not exists public.group_addition_campaigns (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  name text not null,
  group_id uuid references public.groups(id) on delete set null,
  group_external_id text not null,
  group_name text,
  sender_instance_ids uuid[] not null default '{}'::uuid[],
  status text not null default 'active' check (status in ('active','paused','completed','cancelled')),
  authorization_confirmed boolean not null default false,
  total_leads integer not null default 0 check (total_leads >= 0),
  daily_limit_per_sender smallint not null default 15 check (daily_limit_per_sender between 1 and 15),
  interval_minutes smallint not null default 3 check (interval_minutes between 1 and 60),
  work_start_hour smallint not null default 8 check (work_start_hour between 0 and 22),
  work_end_hour smallint not null default 22 check (work_end_hour between 1 and 23),
  starts_at timestamptz not null default now(),
  estimated_finish_at timestamptz,
  completed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint group_addition_campaign_sender_ids_check check (cardinality(sender_instance_ids) > 0),
  constraint group_addition_campaign_window_check check (work_end_hour > work_start_hour)
);

create table if not exists public.group_addition_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  campaign_id uuid not null references public.group_addition_campaigns(id) on delete cascade,
  instance_id uuid not null references public.instances(id) on delete restrict,
  group_id uuid references public.groups(id) on delete set null,
  phone text not null,
  lead_name text,
  sequence integer not null,
  scheduled_at timestamptz not null,
  status text not null default 'queued' check (status in ('queued','processing','added','failed','cancelled','skipped')),
  attempts smallint not null default 0,
  provider_response jsonb,
  error_message text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(campaign_id, phone)
);

create index if not exists group_addition_campaigns_account_idx
  on public.group_addition_campaigns(account_id, created_at desc);

create index if not exists group_addition_jobs_due_idx
  on public.group_addition_jobs(status, scheduled_at)
  where status = 'queued';

create index if not exists group_addition_jobs_campaign_idx
  on public.group_addition_jobs(campaign_id, status);

create index if not exists group_addition_jobs_instance_processed_idx
  on public.group_addition_jobs(instance_id, processed_at)
  where status = 'added';

alter table public.group_addition_campaigns enable row level security;
alter table public.group_addition_jobs enable row level security;

drop policy if exists group_addition_campaigns_tenant_select on public.group_addition_campaigns;
create policy group_addition_campaigns_tenant_select on public.group_addition_campaigns
for select to authenticated
using ((account_id = app_private.current_account_id()) or app_private.is_super_admin());

drop policy if exists group_addition_campaigns_tenant_insert on public.group_addition_campaigns;
create policy group_addition_campaigns_tenant_insert on public.group_addition_campaigns
for insert to authenticated
with check ((account_id = app_private.current_account_id()) or app_private.is_super_admin());

drop policy if exists group_addition_campaigns_tenant_update on public.group_addition_campaigns;
create policy group_addition_campaigns_tenant_update on public.group_addition_campaigns
for update to authenticated
using ((account_id = app_private.current_account_id()) or app_private.is_super_admin())
with check ((account_id = app_private.current_account_id()) or app_private.is_super_admin());

drop policy if exists group_addition_campaigns_tenant_delete on public.group_addition_campaigns;
create policy group_addition_campaigns_tenant_delete on public.group_addition_campaigns
for delete to authenticated
using ((account_id = app_private.current_account_id()) or app_private.is_super_admin());

drop policy if exists group_addition_jobs_tenant_select on public.group_addition_jobs;
create policy group_addition_jobs_tenant_select on public.group_addition_jobs
for select to authenticated
using ((account_id = app_private.current_account_id()) or app_private.is_super_admin());

drop policy if exists group_addition_jobs_tenant_insert on public.group_addition_jobs;
create policy group_addition_jobs_tenant_insert on public.group_addition_jobs
for insert to authenticated
with check ((account_id = app_private.current_account_id()) or app_private.is_super_admin());

drop policy if exists group_addition_jobs_tenant_update on public.group_addition_jobs;
create policy group_addition_jobs_tenant_update on public.group_addition_jobs
for update to authenticated
using ((account_id = app_private.current_account_id()) or app_private.is_super_admin())
with check ((account_id = app_private.current_account_id()) or app_private.is_super_admin());

drop policy if exists group_addition_jobs_tenant_delete on public.group_addition_jobs;
create policy group_addition_jobs_tenant_delete on public.group_addition_jobs
for delete to authenticated
using ((account_id = app_private.current_account_id()) or app_private.is_super_admin());

grant select, insert, update, delete on public.group_addition_campaigns to authenticated;
grant select, insert, update, delete on public.group_addition_jobs to authenticated;

create or replace function public.claim_group_addition_jobs(p_limit integer default 10)
returns setof public.group_addition_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with picked as (
    select j.id
    from public.group_addition_jobs j
    join public.group_addition_campaigns c on c.id = j.campaign_id
    where j.status = 'queued'
      and j.scheduled_at <= now()
      and c.status = 'active'
      and c.authorization_confirmed = true
    order by j.scheduled_at, j.sequence
    for update of j skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  update public.group_addition_jobs j
  set status = 'processing',
      attempts = j.attempts + 1,
      updated_at = now()
  from picked
  where j.id = picked.id
  returning j.*;
end;
$$;

revoke all on function public.claim_group_addition_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_group_addition_jobs(integer) to service_role;
