# UAI Disparos — PostgreSQL local via Cloudflare VPC HTTP (sem alterar SSL global)

Este caminho evita reiniciar o PostgreSQL 18, que também atende os bancos NuCel e Matura.
**É uma migração em desenvolvimento; não faça deploy do site antes de validar tudo.**

## Arquitetura

Cloudflare Worker (Next.js) → binding `UAI_SQL_GATEWAY` → Workers VPC Service HTTP
→ túnel privado `uai-postgres` → gateway Node na porta **3107 somente 127.0.0.1**
→ PostgreSQL 18 na porta 5432 somente local.

Todo o tráfego entre Cloudflare e o computador passa pelo túnel criptografado.
O segmento HTTP dentro do computador é apenas `127.0.0.1:3107`.
Não precisa certificado SSL no PostgreSQL, domínio público, nem expor portas no roteador.

## Infraestrutura já criada (conta Nuvix)

- Tunnel ID: `2539d848-e8d9-435e-9957-6ba67dbfb991` (healthy no último teste)
- VPC Service **TCP** legado: `01a21105-0f3d-70c3-b62a-5b6316c444b8`
- O serviço TCP acima é para PostgreSQL/Hyperdrive e **não é o VPC Service HTTP**.
  Mantenha-o intacto. Precisamos criar um segundo, HTTP, na porta 3107.

## Para configurar na conta certa, quando a migração estiver revisada

O operador executa via Wrangler na conta Nuvix, em uma cópia da branch
`migration/postgres-local`:

```powershell
npx.cmd --yes wrangler@latest vpc service create uai-postgres-api --type http --http-port 3107 --tunnel-id 2539d848-e8d9-435e-9957-6ba67dbfb991 --ipv4 127.0.0.1
```

Adicionar o ID do novo serviço ao `wrangler.jsonc`:

```json
"vpc_services": [
  { "binding": "UAI_SQL_GATEWAY", "service_id": "<ID_DO_NOVO_SERVICO_HTTP>", "remote": true }
]
```

Configurar duas variáveis secretas (sem versionar valores):
- `UAI_GATEWAY_TOKEN`: mesmo token de 32+ caracteres do `services/sql-gateway/.env`;
- `UAI_AUTH_SECRET`: segredo HMAC exclusivo, 32+ caracteres;
- `UAI_QUEUE_SECRET`: segredo exclusivo dos processadores de fila, 32+ caracteres.

Apenas o gateway local conhece `PGPASSWORD`. O Worker **não recebe** a senha do PostgreSQL.

### Serviço local

Dentro de `services/sql-gateway`, criar `.env` a partir de
`.env.example`, preenchendo somente no servidor. Em Node 20.11+:

```powershell
npm.cmd install
npm.cmd run check
npm.cmd start
```

O gateway implementa apenas `/health` e `/sql`, ambos com bearer token; a
porta deve permanecer inacessível pela rede pública ou LAN. A inicialização
automática do túnel e do gateway precisa ser configurada posteriormente.

### Schema / autenticação

O backup das 13 tabelas de 29/09/2026 já foi restaurado no banco `uaidisparos`.
Aplicar `db/migrations/001_local_postgres_legacy_bridge.sql` apenas nesse banco.
Ele cria contas/usuários/sessões e pausa filas legadas para não duplicar envios.

Depois de aplicar a migração, `node scripts/bootstrap-admin.mjs`
permite cadastrar o super-admin e uma senha nova sem compartilhá-la por chat.

### Operação

Não publicar até validar:
1. A URL `/api/health/postgres` deve responder `ok:true` no ambiente de teste.
2. Login, logout, proteção de rotas, criação de cliente e permissões.
3. Instâncias UAZAPI e webhooks; confirmando as credenciais atuais.
4. Diferenciar monitoradoras de disparadoras: o backup tem só **2 monitoradoras**.
5. Confirmar consentimento: os **104 leads** do backup têm `consent_status='unknown'`.
6. Testar envio apenas para destinatário autorizado, e verificar idempotência e limites.
7. Só então substituir produção. Não executar jobs pendentes de setembro automaticamente.

## Atenção

O gateway executa SQL autenticado com as credenciais de `uai_app`. O token é tão
sensível quanto uma senha de banco. Nunca publique nem envie em chat.
A proteção principal é o túnel privado + VPC binding + Bearer token.
