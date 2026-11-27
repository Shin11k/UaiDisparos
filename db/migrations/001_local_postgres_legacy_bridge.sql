-- UAI Disparos: ponte do backup de 29/09/2026 para PostgreSQL sem Supabase.
-- Aplique SOMENTE no banco uaidisparos apos a restauração, nunca no banco postgres/NuCel/Matura.
-- Não recria dados. Não altera registros de envio nem envia mensagens.
BEGIN;
-- PostgreSQL 18 provides gen_random_uuid() natively; no extension privileges required.

CREATE TABLE IF NOT EXISTS public.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  is_primary boolean NOT NULL DEFAULT false,
  instance_limit integer NOT NULL DEFAULT 10 CHECK (instance_limit >= 0),
  permissions jsonb NOT NULL DEFAULT '{"overview":true,"instances":true,"groups":true,"leads":true,"campaigns":true,"group_broadcast":true,"private_broadcast":true,"operations":true,"notifications":true,"settings":true}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uai_one_primary_account ON public.accounts (is_primary) WHERE is_primary;

INSERT INTO public.accounts(name, is_primary, instance_limit)
SELECT 'UAI Disparos - operação principal', true, 10
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE is_primary);

CREATE TABLE IF NOT EXISTS public.local_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'client' CHECK (role IN ('super_admin','admin','client')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uai_local_users_email_key ON public.local_users (lower(email));

CREATE TABLE IF NOT EXISTS public.profiles (
  user_id uuid PRIMARY KEY REFERENCES public.local_users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  name text NOT NULL,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'client' CHECK (role IN ('super_admin','admin','client')),
  permissions jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS uai_profiles_account ON public.profiles(account_id);

CREATE TABLE IF NOT EXISTS public.local_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.local_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS uai_sessions_expires ON public.local_sessions(expires_at);
CREATE INDEX IF NOT EXISTS uai_sessions_user ON public.local_sessions(user_id);

CREATE TABLE IF NOT EXISTS public.system_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  global_instance_capacity integer NOT NULL DEFAULT 100,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.system_settings(id, global_instance_capacity)
VALUES (1, 100) ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  t text;
  primary_account uuid;
BEGIN
  SELECT id INTO primary_account FROM public.accounts WHERE is_primary;
  IF primary_account IS NULL THEN RAISE EXCEPTION 'Conta principal ausente'; END IF;

  FOREACH t IN ARRAY ARRAY[
    'instances', 'groups', 'leads', 'campaigns', 'group_automations',
    'jobs', 'webhook_events', 'suppression_list', 'notification_outbox',
    'notification_settings', 'private_broadcast_recipients',
    'private_broadcasts', 'group_participant_snapshots'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN RAISE EXCEPTION 'Tabela do backup ausente: %', t; END IF;

    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS account_id uuid', t);
    EXECUTE format('UPDATE public.%I SET account_id = $1 WHERE account_id IS NULL', t)
      USING primary_account;
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN account_id SET NOT NULL', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (account_id)',
      'uai_' || t || '_account_idx', t);
  END LOOP;
END $$;

-- Tabelas introduzidas depois da data do backup; ainda ficam sem filas ativas.
CREATE TABLE IF NOT EXISTS public.group_addition_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  name text NOT NULL,
  group_id uuid REFERENCES public.groups(id) ON DELETE SET NULL,
  group_external_id text NOT NULL,
  group_name text,
  sender_instance_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  status text NOT NULL DEFAULT 'paused' CHECK (status IN ('active','paused','completed','cancelled')),
  authorization_confirmed boolean NOT NULL DEFAULT false,
  total_leads integer NOT NULL DEFAULT 0,
  daily_limit_per_sender smallint NOT NULL DEFAULT 15,
  interval_minutes smallint NOT NULL DEFAULT 3,
  work_start_hour smallint NOT NULL DEFAULT 8,
  work_end_hour smallint NOT NULL DEFAULT 22,
  starts_at timestamptz NOT NULL DEFAULT now(),
  estimated_finish_at timestamptz,
  completed_at timestamptz,
  created_by uuid REFERENCES public.local_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.group_addition_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  campaign_id uuid NOT NULL REFERENCES public.group_addition_campaigns(id) ON DELETE CASCADE,
  instance_id uuid NOT NULL REFERENCES public.instances(id),
  group_id uuid REFERENCES public.groups(id) ON DELETE SET NULL,
  phone text NOT NULL,
  lead_name text,
  sequence integer NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','added','failed','cancelled','skipped')),
  attempts smallint NOT NULL DEFAULT 0,
  provider_response jsonb,
  error_message text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(campaign_id, phone)
);
CREATE INDEX IF NOT EXISTS uai_group_addition_jobs_due
  ON public.group_addition_jobs(status, scheduled_at);
CREATE INDEX IF NOT EXISTS uai_group_addition_campaigns_account
  ON public.group_addition_campaigns(account_id);

-- Filas permanecem paradas até validação explícita, evitando reenviar jobs antigos.
UPDATE public.group_automations SET active = false WHERE active = true;
UPDATE public.private_broadcasts SET status = 'paused' WHERE status = 'active';
UPDATE public.jobs SET status = 'paused' WHERE status IN ('queued','processing');
COMMIT;
