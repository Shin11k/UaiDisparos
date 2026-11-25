# Migração UAI Disparos — Supabase pausado para PostgreSQL no servidor

Status: **preparação isolada**, branch `migration/postgres-local`. NÃO é produção.

## Objetivo
- Manter o frontend Next.js no Cloudflare Worker.
- Manter UAZAPI e a estrutura de contas/usuários do UAI.
- Migrar dados e autenticação do Supabase pausado para PostgreSQL instalado no servidor.
- Não abrir a porta 5432 do PostgreSQL na internet.

## Bloqueios reais antes do corte
1. **Backup original do Supabase** ainda não foi fornecido. Sem ele não existem dados para restaurar.
   O SQL publicado em `supabase/schema.sql` é anterior às tabelas e triggers de multitenancy:
   não o trate como substituto de um backup da produção.
2. **Servidor local** ainda não está acessível por esta sessão. Precisamos verificar serviço PostgreSQL,
   porta, versão, usuário de banco específico, ambiente Node e conexão segura à Cloudflare.
3. **Autenticação:** o código usa `@supabase/ssr` e `auth.signInWithPassword()`, além de
   `auth.users`, políticas RLS, cookies e identidade por conta. É necessário migrar a autenticação
   e manter o mesmo vínculo de IDs de perfil/conta. Não basta alterar `DATABASE_URL`.
4. **Rede:** para o Worker chegar ao servidor privado, usar Cloudflare Tunnel + Workers VPC/Hyperdrive
   ou o gateway HTTPS autenticado preparado em `services/sql-gateway`.
   O servidor PostgreSQL não deve ser exposto publicamente.

## Preparação no Windows do servidor
No PowerShell, com uma cópia do repositório:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\diagnosticar-postgres.ps1
```

Se a porta PostgreSQL for diferente de 5432, informe-a com `-Port`.

## Gateway de teste local (NÃO autentica usuários nem migra dados ainda)
`services/sql-gateway` contém apenas o primeiro estágio de conectividade privada.
Ele exige token forte, aceita chamadas somente no localhost e implementa apenas
`GET /health`. Não existe endpoint para executar SQL arbitrário pela internet.

```powershell
cd services\sql-gateway
Copy-Item .env.example .env
# Preencha .env LOCALMENTE no servidor, sem compartilhar senhas.
npm.cmd install
npm.cmd run check
npm.cmd start
```

O segredo `UAI_GATEWAY_TOKEN` deve ficar no servidor e, futuramente, no Secret do Worker.
Apenas o gateway usa `PGPASSWORD`. Nunca coloque dados de acesso ao PostgreSQL no navegador
ou nos arquivos versionados do repositório.

## Etapas de migração depois de receber o backup
1. Inspecionar backup e dependências (sem restaurar por cima de outro banco).
2. Criar database limpo e contas limitadas de aplicação.
3. Restaurar as tabelas de negócio, vínculos e dados. Migrar funções Supabase-específicas.
4. Substituir Auth por autenticação própria, segura e com troca/redefinição de senha se necessário.
5. Adaptar rotas de API, filas, webhooks e jobs ao PostgreSQL sem dependências Supabase.
6. Configurar Tunnel/VPC ou gateway HTTPS protegido; testar login com conta de teste.
7. Verificar contagens de leads/grupos/instâncias/campanhas e só depois publicar a troca.
8. Manter backup antigo disponível para rollback.

**Importante:** não restaure o backup diretamente no banco de outros sistemas.
**Não altere o Worker em produção antes de validar login e leitura/gravação no PostgreSQL novo.**
