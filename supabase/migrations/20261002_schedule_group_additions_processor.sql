-- Requires Vault secrets created in the project:
-- uai_project_url
-- uai_anon_key
select cron.schedule(
  'uai-process-group-additions',
  '* * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name='uai_project_url' limit 1)
             || '/functions/v1/process-group-additions',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'apikey',(select decrypted_secret from vault.decrypted_secrets where name='uai_anon_key' limit 1),
        'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='uai_anon_key' limit 1)
      ),
      body := jsonb_build_object('source','cron','time',now()),
      timeout_milliseconds := 15000
    );
  $$
);
