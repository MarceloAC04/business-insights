-- ================================================================
-- MIGRATION 015 — Foto do perfil e categorias de serviço
-- Salon App
-- ================================================================
-- Depende de 010_personalizacao_agendamento_publico.sql, que introduz
-- `servicos.categoria`. A imagem fica pública porque aparece no link de
-- agendamento; somente o FastAPI (service role) faz uploads.

-- ── Foto pública do salão ──────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'fotos-salao',
  'fotos-salao',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Não há policy de upload para usuárias: o navegador nunca acessa Storage.
-- O bucket é público só para permitir que a foto apareça no agendamento sem
-- expor token; o objeto é escrito pelo FastAPI com a service role.

-- ── Categorias independentes ───────────────────────────────────────────────

create table if not exists servico_categorias (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  nome text not null check (length(btrim(nome)) between 1 and 60),
  criado_em timestamptz not null default now()
);

create unique index if not exists servico_categorias_usuario_nome_unico
  on servico_categorias (user_id, lower(btrim(nome)));

-- Mantém os serviços já existentes selecionáveis assim que a tela nova entrar.
insert into servico_categorias (user_id, nome)
select distinct user_id, btrim(categoria)
from servicos
where categoria is not null and btrim(categoria) <> ''
on conflict (user_id, lower(btrim(nome))) do nothing;
