# CLAUDE.md — Thamires Borges Beauty (business-insights)

Contexto permanente do projeto. Leia antes de tocar em qualquer arquivo.

## O que é

App de gestão financeira para um salão de beleza de uma profissional autônoma
(Thamires Borges Beauty). Responde a uma pergunta só, de várias formas: **"eu estou
ganhando ou perdendo dinheiro?"** — por atendimento, por mês, por serviço.

Usuária única, não técnica, usando **celular no dia a dia** e **navegador quando senta
para fechar as contas**.

## Mudança de stack (04/09/2026)

Decisão do dono do projeto: **o frontend deixa de ser Flutter e passa a ser só React**,
cobrindo tudo (web e o uso no celular, por navegador responsivo). Não é uma dedução —
foi pedido explicitamente, e vale a partir desta data.

- **`frontend/salao_app/` (Flutter) está congelado.** Não é apagado — fica como
  histórico e referência — mas **não recebe mais desenvolvimento** até decisão em
  contrário. Todo o conteúdo deste arquivo que descreve Flutter (padrão de projeto,
  decisões A2/A4/A8, checklist, fases F0–F5, modo demo) descreve **esse código
  congelado**, não o alvo atual.
- **`frontend/salao_web/` (React) é o novo e único frontend.** Hoje só tem as
  dependências instaladas (`node_modules/`, `.tanstack/`) — **ainda não existe
  código-fonte**. O `package-lock` interno identifica o projeto como `glowapp-web`
  (provável origem Lovable) com esta stack:
  - **React + TypeScript + Vite**
  - **TanStack Router** + **TanStack Start** (roteamento / SSR-ready) + **TanStack
    Query** (dados do servidor)
  - **React Hook Form** + **Zod** (formulários e validação)
  - **Tailwind CSS v4** + **Radix UI** (base de componentes, padrão shadcn/ui)
  - **lucide-react** (ícones), **date-fns** + **react-day-picker** (datas/calendário —
    já dá base pronta para telas de agendamento)
  - Sem Redux/Zustand instalado: o estado de servidor deve passar por TanStack Query;
    estado de UI local fica em React state/Context até haver motivo pra outra coisa.
- **Não há build nativo Android/iOS por enquanto.** A8 (bundle id, `android/`/`ios/`)
  fica sem efeito prático enquanto essa decisão não for revisitada.
- **O padrão de projeto para React ainda não existe** — só a stack está fixada pelas
  deps instaladas. Antes de escrever módulos (`R3` abaixo), definir e documentar aqui:
  estrutura de pastas, onde mora a chamada HTTP (uma `baseUrl` só, igual A1), como a
  sessão é guardada (`localStorage`? cookie?), convenção de nomes de arquivo/componente.
  **Não inventar isso ad-hoc tela por tela** — é a mesma razão pela qual o padrão
  Flutter existia.

## A1 volta a valer — FastAPI é o caminho principal de novo (06/09/2026)

Decisão do dono do projeto, na branch `feat/api-integracao-supabase`: **A1 é
restaurada**, por cima da reversão de 05/09 descrita logo abaixo (que fica preservada
como histórico, não apagada). O `frontend/salao_web` volta a falar só com o FastAPI
por uma única `baseUrl`; o acesso direto ao Supabase feito na branch
`feat/react-supabase` **não foi apagado** — continua existindo em código — mas passa a
ser **Plano B**, sem ser o caminho ativo enquanto esta decisão valer.

- **Método do trabalho nesta branch**: varredura módulo a módulo, **na mesma ordem** já
  usada na migração anterior — Auth → Resumo → Atendimentos → Gastos → Estoque → Kits →
  Perfil → Servicos → Alertas → Agendamento_publico. Para cada módulo: comparar a
  implementação do frontend que fala direto com o Supabase (já verificada ponta a ponta
  contra o projeto real, branch `feat/react-supabase`) contra o
  router/service/schema do FastAPI correspondente, e corrigir o que faltava ou estava
  errado na API antes de passar ao próximo módulo. Essa varredura está **completa** —
  os dez módulos foram fechados, cada um com commit próprio no histórico desta branch.
  Importante: isso fechou **divergências entre o que já existia dos dois lados**, não
  é o mesmo que terminar `pedidos-backend.md` — endpoints que nunca chegaram a existir
  no FastAPI continuam faltando (ver "Dívidas conhecidas do backend" abaixo).
- Bugs reais encontrados e corrigidos nessa varredura:
  - **Escopo por `user_id` faltando em vários `update`/`delete`** (Perfil, Servicos,
    Alertas) — o cliente `service_role` do FastAPI ignora RLS, então um
    `.eq("user_id", ...)` explícito no update/delete é a única barreira de fato; sem
    ele, uma checagem de posse só na leitura não impede escrever/apagar o registro de
    outro `user_id`.
  - **Bug de fuso horário**: `date.today()` usa o fuso do servidor (UTC em produção),
    não o de Brasília — corrigido em `perfil_service.py` com o mesmo padrão
    `_hoje_brasil()` já usado em `gastos_service.py`.
  - **`PUT /perfil` apagava a foto salva** sempre que `foto_url` vinha omitido (o
    Pydantic não distingue "campo omitido" de "campo enviado como null", e o frontend
    nunca envia esse campo) — corrigido para só escrever `foto_url` quando vier
    preenchido.
  - **`DELETE /servicos/{id}` fazia hard delete** quando o serviço nunca tinha sido
    usado em atendimento; o frontend sempre espera soft delete (`ativo: false`) —
    unificado para sempre soft delete, batendo com o próprio docstring do endpoint.
  - **Check constraint de `alertas.tipo`/`alertas.referencia_tipo` desatualizado**: o
    schema Python (`TipoAlerta`) já tinha `custo_fixo_a_vencer`/`custo_fixo_vencido`
    havia tempo, mas o constraint do banco nunca foi atualizado — nova migração
    `007_alertas_tipo_custo_fixo.sql` (confirmada aplicada em 06/09/2026, ver abaixo).
  - **`agendamento_publico_service.py` reimplementava em Python**, contra as tabelas
    cruas com o `service_role`, a mesma lógica que já existe nas 3 RPCs `security
    definer` de `005_agendamento_publico_rpc.sql` — com uma janela de corrida real e
    **admitida pelo próprio código** entre a checagem de horário livre e o insert do
    atendimento. Reescrito para delegar às RPCs (`supabase.rpc(...)`), que fecham essa
    janela com `pg_advisory_xact_lock` por salão. Nenhuma RPC depende de `auth.uid()`
    (resolvem o salão pelo `slug`), então funcionam idênticas chamadas pelo
    `service_role` ou pela `anon key` do frontend — não precisou de migração nova.
- **As duas migrações abaixo foram confirmadas aplicadas no projeto Supabase real em
  06/09/2026** (verificação não destrutiva: assinatura de RPC via `hint` do
  `PGRST202` para a 006; insert-then-delete de uma linha de teste em `alertas` com
  `tipo = 'custo_fixo_a_vencer'` para a 007 — nenhum dado real foi alterado):
  - `006_ajustar_estoque_rpc_service_role.sql` — adiciona `p_user_id` explícito a
    `ajustar_estoque`, necessário pro FastAPI chamar essa RPC como `service_role` (sem
    `auth.uid()` de sessão). O código Python (`estoque_service.py`, `kits_service.py`,
    `atendimentos_service.py`) já chama a RPC com os nomes de parâmetro certos.
  - `007_alertas_tipo_custo_fixo.sql` — corrige os check constraints de `alertas`
    descritos acima.
- **A dívida do JWT sem verificação de assinatura volta a ser uma falha de segurança
  ativa** (ver "Dívidas conhecidas do backend" abaixo) — deixa de ser "código parado
  sem consumidor" agora que a API tem consumidor de novo.
- Todo texto deste arquivo que ainda diz "`api/` não tem mais consumidor", "sem trilha
  ativa" ou equivalente está desatualizado a partir desta data — corrija ao encostar.

## Reversão de A1 (05/09/2026) — histórico, superada pela seção acima

Registro mantido por ser referência de como e por que o app passou uma janela falando
direto com o Supabase — não descreve mais o estado atual.

Decisão do dono do projeto, na branch `feat/react-supabase`: **A1 caiu**. O
`frontend/salao_web` não passava mais pelo FastAPI — falava direto com o Supabase pelo
cliente `@supabase/supabase-js` (chave `anon`), módulo por módulo, na ordem **Auth →
Resumo → Atendimentos → Gastos → Estoque → Kits → Perfil → Servicos → Alertas →
Agendamento_publico**. Essa lista ficou **completa** — os dez módulos migraram e foram
verificados ponta a ponta contra o projeto Supabase real. Esse código **continua
existindo** em `frontend/salao_web` como Plano B (ver seção acima) — só deixou de ser o
caminho ativo.

- RLS (`using (auth.uid() = user_id)`) era a fronteira de autorização nesse desenho, não
  o FastAPI. A chave `service_role` nunca deve ir ao cliente — só a `anon`, em
  `lib/supabase.ts` — regra que continua valendo para o código do Plano B.
- Onde RLS não bastava (atomicidade de saldo, ou operação sem sessão que precisa
  enxergar através da RLS), a regra virou função Postgres `security definer`, chamada
  via `supabase.rpc(...)`: `ajustar_estoque` (`004_ajustar_estoque_rpc.sql`, saldo de
  estoque/kit) e as três de `005_agendamento_publico_rpc.sql`
  (`agendamento_publico_pagina/horarios/agendar` — o único módulo sem login). Essas RPCs
  continuam existindo e agora também são chamadas pelo FastAPI (ver seção acima).

## Repositório

```
business-insights/
├── CLAUDE.md                      # este arquivo
├── .specs/
│   ├── 00-ENTREGA-BACKEND.md      # índice único do que entregar ao backend — comece aqui
│   ├── padrao-de-projeto-flutter/ # padrão do código Flutter CONGELADO — não é mais o alvo
│   ├── padrao-flutter-salao.md    # divergências do Flutter em relação ao padrão acima
│   ├── padrao-de-projeto-react.md # padrão do frontend atual (React) — trilha R0, fechada
│   ├── endpoints-backend.md       # contrato: operações que o FastAPI deve expor (framework-agnóstico)
│   └── pedidos-backend.md         # ordens de serviço da F4, em lotes L0–L8
├── api/                           # FastAPI — caminho principal de novo (06/09/2026)
├── database/
│   ├── schema.sql                 # Supabase/Postgres (estado antes da V1, histórico)
│   └── migrations/
│       ├── 001_v1_completo.sql             # idempotente: tabelas novas + ajustes
│       ├── 002_seed_teste.sql              # dados de teste (NÃO rodar em produção)
│       ├── 003_agendamento_publico.sql     # slug, horario_funcionamento, origem
│       ├── 004_ajustar_estoque_rpc.sql     # RPC security definer: saldo de estoque/kit
│       ├── 005_agendamento_publico_rpc.sql # RPCs security definer: link público
│       ├── 006_ajustar_estoque_rpc_service_role.sql # p_user_id p/ chamada via service_role — aplicada (confirmado 06/09/2026)
│       └── 007_alertas_tipo_custo_fixo.sql           # check constraints de alertas — aplicada (confirmado 06/09/2026)
├── frontend/
│   ├── salao_app/                 # Flutter — CONGELADO (04/09/2026), não desenvolver
│   └── salao_web/                 # React — fala com a API FastAPI (Plano B: Supabase
│                                   # direto, código preservado, branch feat/react-supabase)
└── n8n/                           # automações (WhatsApp, cron, resumos)
```

O padrão em `.specs/padrao-de-projeto-flutter/` é uma cópia vendorizada de
`F:\projects\FrotaOP_mobile\padrao-de-projeto-flutter`, mantida por ser referência do
código congelado. Não é a fonte da verdade para o que vem agora.

## Decisões de arquitetura (02/09/2026, revisadas em 04/09/2026)

Estas foram decididas pelo dono do projeto e **não devem ser revisitadas sem ele**.
Vieram de perguntas explícitas, não de dedução. As de negócio/backend continuam
valendo para qualquer frontend; as de implementação Flutter só valem para o código
congelado.

| # | Decisão | Status | Consequência |
|---|---|---|---|
| **A1** | **Tudo via FastAPI.** Uma única `baseUrl`. O frontend fala com o Supabase só como Plano B. | ✅ Restaurada (06/09/2026), após uma janela revertida (05–06/09/2026) | Ver "A1 volta a valer" acima. O `salao_web` volta a falar só com o FastAPI; o acesso direto ao Supabase (`feat/react-supabase`) continua em código como Plano B. `.specs/endpoints-backend.md` volta a ser o contrato que o FastAPI implementa, não só histórico. |
| **A2** | **Módulo `auth` completo.** Login, token, interceptor 401, route guard. | ⚠️ Vale o conceito; implementação Flutter (`AppStorage`, interceptor Dio) está congelada | Em React precisa do equivalente: onde o token fica, como toda chamada autenticada reage a 401, como a rota protegida redireciona — a definir junto do padrão de projeto React. |
| **A3** | **Alertas in-app + push agora; WhatsApp e e-mail só mapeados.** | ✅ Vigente | Badge, banner, central de alertas continuam necessários em React. Push depende de F5 (abaixo), hoje sem prioridade sem build nativo. Endpoints de WhatsApp/e-mail seguem *futuro* — n8n já tem fluxos prontos. |
| **A4** | **`AppStorage` só sobre `SharedPreferences`.** | 🧊 Congelada (só Flutter) | Não se aplica a React. Equivalente (provavelmente `localStorage`, sem offline-first) fica para o padrão de projeto React. |
| **A5** | **Estoque insuficiente avisa, não bloqueia.** Finalizar atendimento e montar kit perguntam "quer registrar mesmo assim?". | ✅ Vigente | Duas passadas no mesmo endpoint: a primeira não grava nada e devolve `409 ESTOQUE_INSUFICIENTE` com `result.faltantes`; a segunda leva `confirmar_estoque_insuficiente: true`, deixa o saldo negativo e gera alerta. `StatusEstoque` ganha `negativo`, distinto de `critico`. Regra é do backend — qualquer frontend só exibe o aviso. |
| **A6** | **Custo do item é média ponderada móvel**, não o último preço pago. | ✅ Vigente | Cada entrada recalcula `custo_medio`; `custo_ultima_compra` fica ao lado, informativo. Regra do backend. |
| **A7** | **Montar kit é operação real.** Kit tem saldo próprio (`quantidade_montada`). | ✅ Vigente | Montar consome insumo e passa pelo aviso de A5; vender **não** tem segunda passada — `KIT_NAO_MONTADO` é definitivo. Regra do backend. |
| **A8** | **Bundle id `br.com.thamiresbeauty.salao`**, nome de exibição "Thamires Beauty". | 🧊 Congelada (só Flutter, sem build nativo por ora) | `android/`/`ios/` continuam existindo em `salao_app`, mas não há mais trilha ativa para publicar nas lojas enquanto o frontend for só React. |
| **A9** | **Resumo é a entrada do app e segue o painel Lovable de 02/09/2026.** | ✅ Vigente (conceito) | Continua sendo a rota inicial: alerta, resultado mensal, histórico de seis meses, lucro por serviço, meta, próximos gastos e reposição. A implementação de navegação lateral/inferior é a reinventar em React — o conceito (menos itens de menu no mobile, mais no desktop) segue válido. |

### O que essas decisões apagam do estado atual

- `api/README.md` e o docstring de `api/app/main.py`, se ainda disserem "CRUD puro →
  Supabase REST (frontend chama diretamente)", estão descrevendo a janela de
  05–06/09/2026 (A1 revertida), não o estado atual — corrija ao encostar: o FastAPI
  volta a ser quem o frontend chama, com uma única `baseUrl`.
- O `schema.sql` foi desenhado para RLS com a *anon key* do Supabase, pensando num
  cliente batendo direto — isso **continua sendo verdade para o Plano B**
  (`feat/react-supabase`), mas não é mais o caminho ativo. A autorização real do
  caminho ativo volta a ser o FastAPI + `service_role`, com o cuidado (redescoberto
  nesta varredura) de que `service_role` ignora RLS — cada `update`/`delete` do
  backend precisa do próprio `.eq("user_id", ...)` explícito, já que não há mais uma
  RLS de verdade barrando por baixo.

## Padrão de projeto Flutter (congelado)

Vale só para `frontend/salao_app/`, que não recebe mais desenvolvimento. Mantido aqui
para quem precisar entender ou recuperar algo de lá.

`.specs/padrao-de-projeto-flutter/` vale **integralmente** para esse código, com as
divergências registradas em `.specs/padrao-flutter-salao.md`. Resumo de uma linha:

> Cubit por módulo → `BlocSubState` por operação → Repository injetado (interface +
> impl) → `AppApi` (Dio) → Model com `fromResponse(Map)` → estado emitido com
> `copyWith`; persistência via `AppStorage`; navegação e i18n globais por
> `navigatorKey`.

## Padrão de projeto React

Fechado em `.specs/padrao-de-projeto-react.md` (trilha **R0** concluída). Resumo de uma
linha, espelhando o do Flutter:

> Módulo (`modules/*`) → `api.ts` (chamadas via `apiFetch` único) → `queries.ts`
> (`useQuery`/`useMutation` do TanStack Query) → `schemas.ts` (Zod, valida request e
> response) → sessão em `localStorage` via `lib/auth.ts` → rotas por arquivo
> (TanStack Router/Start) com guard em `_authenticated`.

Decisão que diverge do Flutter e vale registrar aqui: **sem i18n** (ARB não tem
equivalente) — um idioma só, sem plano de internacionalizar, strings direto no
componente em pt-BR. Detalhe e justificativa em `padrao-de-projeto-react.md` (R9).

## Módulos

Unidade de dado, não de tela — nomes valem independente do framework que os implementa.

| Módulo | Responsabilidade | Tela no protótipo |
|---|---|---|
| `auth` | login, refresh, logout, sessão, guard | — (derivada da paleta) |
| `atendimentos` | agendar, finalizar, cancelar, listar; saldo do período | Atendimentos |
| `agendamento_publico` | tela sem login, aberta pelo link fixo do salão; cliente marca sozinho | Atendimentos (fonte externa) |
| `gastos` | lançar, marcar pago, listar pendentes/pagos | Gastos |
| `resumo` | consolidação mensal, insights, precificação | Resumo |
| `estoque` | itens e movimentações | Estoque |
| `kits` | kits de revenda | Estoque (seção) |
| `perfil` | dados do salão e custos fixos | Perfil |
| `servicos` | tabela de preços e produtos padrão | Perfil (seção) |
| `alertas` | estoque baixo, gastos a vencer, central, badge, push | transversal |

Nenhum passa de ~8 operações — é por isso que `kits` sai de `estoque` e `servicos` sai
de `perfil`, embora dividam tela.

## Design system

Paleta e layout vêm de `design-todas-telas.html` (protótipo aprovado). **A paleta é
roxa; verde e vermelho são reservados a positivo/negativo** (saldo, pago/pendente,
estoque ok/alerta) — trocar isso prejudica a leitura financeira e não deve ser feito.
Isso vale para qualquer frontend.

```
primary        #BD6DF2    primary-dark   #896393    primary-accent #BD4EBF
primary-mid    #C9A0F2    primary-light  #EAE6E5
success #3B6D11 · success-light #EAF3DE · success-mid #C0DD97
danger  #A32D2D · danger-light  #FCEBEB · danger-mid  #F09595
amber   #854F0B · amber-light   #FAEEDA
text-1 #1A1A1A · text-2 #6B6B6B · text-3 #9E9E9E
surface #FFFFFF · surface-2 #F7F7F5 · border #EAE6E5 · scaffold #FFFFFF
```

No Flutter congelado estava em `settings/app_colors.dart`. Em React, o natural é virar
tokens do Tailwind (`tailwind.config`) ou variáveis CSS em `:root` — a decidir junto do
padrão de projeto React, mas os valores acima não mudam. O `scaffold` é branco (decisão
do dono do projeto, não o lilás `#F1EDF0` do protótipo original) — cartões se destacam
pela borda e sombra, não pelo contraste com o fundo.

### Casca por dispositivo (conceito, vale para qualquer frontend)

- **mobile / tablet** — bottom nav, ação primária em FAB.
- **desktop** — menu lateral, sem bottom nav/FAB; ação primária vira botão no cabeçalho.
- Listas: **cartões empilhados** no mobile, **tabela** ou grid de duas colunas na web —
  mesmo dado, densidade diferente, não telas diferentes.

A implementação concreta (`AppScaffold`, breakpoint em 1024px) é do Flutter congelado.
Em React isso normalmente vira componentes de layout + Tailwind responsive variants —
a definir.

### Ícones

O protótipo usa Tabler Icons. No Flutter congelado, `settings/app_assets.dart` mapeava
cada um para Material (SVGs originais não estavam disponíveis). Em React,
**`lucide-react` já está instalado** — ao montar as telas, mapear cada ícone Tabler do
protótipo para o equivalente Lucide (mais próximo visualmente do Tabler que o Material).

## Estado da migração

### Trilha Flutter (congelada em 04/09/2026)

Ficou pronta até onde chegou e não recebe mais trabalho:

- [x] **F0 — Contexto.**
- [x] **F1 — Infra.**
- [x] **F2 — Design system.**
- [x] **F3 — Módulos** (9), completos com testes.
- [ ] **F4 — Backend.** Não terminou (ver "Trilha backend" abaixo) — mas não é mais
      bloqueio de frontend nenhum: o backend serve a API, não o Flutter especificamente.
- [ ] **F5 — Push.** Pausada — dependia de build nativo, hoje sem prioridade.

Portões que valiam para essa trilha: `flutter analyze` sem aviso · `flutter test` com
75 testes verdes · `flutter build web --release` concluindo. Não rodar mais tarefas
nessa trilha sem pedido explícito do dono do projeto.

**Modo demo** (Flutter, congelado): servidor falso em memória
(`repositories/demo/demo_database.dart`), ligado por
`flutter run -d chrome --dart-define-from-file=env/demo.json`. Documentado aqui só
como referência de regra de negócio executável (as duas passadas de A5, a média
ponderada de A6, o `KIT_NAO_MONTADO` de A7 estão codificadas lá) — útil de consultar
mesmo sem tocar mais no Flutter.

### Trilha React (feita, hoje é o código do Plano B)

- [x] **R0 — Padrão de projeto.** Ver `.specs/padrao-de-projeto-react.md`.
- [x] **R1 — Infra.** Cliente Supabase único (`lib/supabase.ts`), tokens do design
      system (Tailwind), layout responsivo (casca mobile/desktop), roteamento base.
- [x] **R2 — Módulo `auth`.**
- [x] **R3 — Demais módulos**, todos migrados para falar direto com o Supabase (branch
      `feat/react-supabase`), nesta ordem: Auth, Resumo, Atendimentos, Gastos, Estoque,
      Kits, Perfil, Servicos, Alertas, Agendamento_publico. Cada um foi verificado ponta
      a ponta contra o projeto Supabase real antes de passar para o próximo. Esse código
      **continua existindo e passando pelos mesmos testes** — só deixou de ser o
      caminho ativo com "A1 volta a valer" (acima). `.specs/endpoints-backend.md` volta
      a valer como contrato de endpoint do FastAPI, além de registro de regra de
      negócio.

### Trilha backend (reaberta em 06/09/2026 — API tem consumidor de novo)

- [x] **Varredura de paridade módulo a módulo** (branch `feat/api-integracao-supabase`):
      os dez módulos que já tinham implementação nos dois lados (FastAPI e
      Supabase-direto) foram comparados e as divergências fechadas — ver "A1 volta a
      valer" acima para a lista de bugs corrigidos.
- [ ] **F4 — Backend completo.** A varredura acima fechou divergências entre código
      **que já existia** dos dois lados — não é o mesmo que terminar
      `pedidos-backend.md`: endpoint que nunca chegou a ser implementado no FastAPI
      continua faltando (ver dívidas abaixo).
- [ ] **L0.2 — JWT sem verificação de assinatura.** Volta a ser prioridade viva, não
      código parado (ver dívida abaixo).

### Dívidas conhecidas do backend (ativas de novo — API tem consumidor)

- **`_extrair_user_id` decodifica o JWT sem verificar assinatura**
  (`api/app/routers/relatorio.py`). **Com A1 restaurada isso é falha de segurança
  ativa** — qualquer um forja um `sub` e chama a API como qualquer usuária. É o lote
  **L0.2** de `pedidos-backend.md`, marcado 🔴 — validar com o `SUPABASE_JWT_SECRET`
  antes de expor este backend a tráfego real.
- **Contrato de `gastos` diverge**: o app usa `forma_pagamento` ∈ {avista, credito,
  debito, pix} + `categoria` ∈ {material, fixo, outros}; o `schema.sql` usa
  {'à vista','cartão'} + `prioridade` ∈ {alta, média, baixa}. O mapa de endpoints
  define o contrato vencedor, e `001_v1_completo.sql` já converte os dados existentes.
- **`RelatorioMensal` (plano) ≠ `ResumoMensal` (API, aninhado)**. Vence o da API,
  estendido com os insights do protótipo (ticket médio, margem, comparativo com o mês
  anterior, serviço mais lucrativo).
- **Endpoints que faltam**: `pedidos-backend.md` é a lista do que falta, em ordem de
  dependência — a varredura de paridade (acima) não cobriu isso, só o que já existia
  dos dois lados.

## Convenções de trabalho

- Domínio em **português** (`AtendimentoModel`/`Atendimento`, `getGastosPath`), nomes
  de infraestrutura/framework em **inglês**, seguindo o que o padrão Flutter já fazia —
  manter a mesma convenção em React. Texto de UI: sempre em pt-BR (mecanismo de
  tradução a decidir na trilha R0).
- Commits em português, como o histórico do repositório.
- Não invente contrato de API: se falta endpoint, ele entra em
  `.specs/endpoints-backend.md` antes de existir código que o chame — vale para
  qualquer frontend.
