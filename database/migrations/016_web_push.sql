-- Web Push padrão do navegador (VAPID).
-- O token continua sendo o endpoint para preservar a unicidade existente;
-- as chaves de criptografia ficam separadas em JSONB e nunca são expostas na
-- resposta do endpoint.
alter table public.dispositivos
  add column if not exists assinatura_web_push jsonb;

comment on column public.dispositivos.assinatura_web_push is
  'PushSubscription JSON do navegador; preenchido apenas para plataforma web';

alter table public.alertas
  add column if not exists push_enviado_em timestamptz;

-- Alertas que já existiam antes do Web Push não devem gerar uma enxurrada de
-- notificações na primeira abertura da central depois da migração.
update public.alertas
set push_enviado_em = criado_em
where push_enviado_em is null;

comment on column public.alertas.push_enviado_em is
  'Momento em que este alerta foi entregue a pelo menos um dispositivo Web Push';
