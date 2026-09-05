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

## Reversão de A1 — frontend fala direto com o Supabase (05/09/2026)

Decisão do dono do projeto, na branch `feat/react-supabase`: **A1 caiu**. O
`frontend/salao_web` não passa mais pelo FastAPI — fala direto com o Supabase pelo
cliente `@supabase/supabase-js` (chave `anon`), módulo por módulo, na ordem **Auth →
Resumo → Atendimentos → Gastos → Estoque → Kits → Perfil → Servicos → Alertas →
Agendamento_publico**. Essa lista está **completa** — os dez módulos já migraram e
foram verificados ponta a ponta contra o projeto Supabase real.

- **RLS (`using (auth.uid() = user_id)`) é a fronteira de autorização agora**, não o
  FastAPI. Nunca a chave `service_role` no cliente — só a `anon`, em `lib/supabase.ts`.
- **Onde RLS não basta** (atomicidade de saldo, ou operação sem sessão que precisa
  enxergar através da RLS), a regra vira função Postgres `security definer`, chamada
  via `supabase.rpc(...)`: `ajustar_estoque` (`004_ajustar_estoque_rpc.sql`, saldo de
  estoque/kit) e as três de `005_agendamento_publico_rpc.sql`
  (`agendamento_publico_pagina/horarios/agendar` — o único módulo sem login, que
  precisa ver nome do salão/tabela de preços/expediente sem `auth.uid()`, e travar com
  `pg_advisory_xact_lock` para não deixar dois clientes públicos reservarem o mesmo
  horário). Isso é o substituto direto do que o service role do FastAPI fazia — é
  security definer, nunca `service_role` no cliente.
- **`api/` (FastAPI) não tem mais consumidor.** Continua existindo — não foi apagado —
  mas nenhum frontend fala com ele; sem trilha ativa enquanto essa decisão não for
  revisitada. A "Trilha backend" e as dívidas de contrato descritas mais abaixo (§
  "Dívidas conhecidas do backend") descrevem esse código parado, não um bloqueio atual.
- Todo código/comentário deste arquivo que ainda diz "A1 vigente" ou "o frontend nunca
  fala com o Supabase" está desatualizado — corrija ao encostar.

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
├── api/                           # FastAPI — sem consumidor desde a reversão de A1 (05/09/2026)
├── database/
│   ├── schema.sql                 # Supabase/Postgres (estado antes da V1, histórico)
│   └── migrations/
│       ├── 001_v1_completo.sql             # idempotente: tabelas novas + ajustes
│       ├── 002_seed_teste.sql              # dados de teste (NÃO rodar em produção)
│       ├── 003_agendamento_publico.sql     # slug, horario_funcionamento, origem
│       ├── 004_ajustar_estoque_rpc.sql     # RPC security definer: saldo de estoque/kit
│       └── 005_agendamento_publico_rpc.sql # RPCs security definer: link público
├── frontend/
│   ├── salao_app/                 # Flutter — CONGELADO (04/09/2026), não desenvolver
│   └── salao_web/                 # React — frontend atual, fala direto com o Supabase
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
| **A1** | **Tudo via FastAPI.** Uma única `baseUrl`. O frontend **nunca** fala com o Supabase (nem PostgREST, nem RPC, nem SDK). | ❌ Revertida (05/09/2026) | Ver "Reversão de A1" acima. O `salao_web` fala direto com o Supabase; RLS é a fronteira de autorização; regra que a RLS não cobre vira função `security definer`. O mapa de endpoints (`.specs/endpoints-backend.md`) e o FastAPI ficam como referência de contrato/histórico, sem consumidor. |
| **A2** | **Módulo `auth` completo.** Login, token, interceptor 401, route guard. | ⚠️ Vale o conceito; implementação Flutter (`AppStorage`, interceptor Dio) está congelada | Em React precisa do equivalente: onde o token fica, como toda chamada autenticada reage a 401, como a rota protegida redireciona — a definir junto do padrão de projeto React. |
| **A3** | **Alertas in-app + push agora; WhatsApp e e-mail só mapeados.** | ✅ Vigente | Badge, banner, central de alertas continuam necessários em React. Push depende de F5 (abaixo), hoje sem prioridade sem build nativo. Endpoints de WhatsApp/e-mail seguem *futuro* — n8n já tem fluxos prontos. |
| **A4** | **`AppStorage` só sobre `SharedPreferences`.** | 🧊 Congelada (só Flutter) | Não se aplica a React. Equivalente (provavelmente `localStorage`, sem offline-first) fica para o padrão de projeto React. |
| **A5** | **Estoque insuficiente avisa, não bloqueia.** Finalizar atendimento e montar kit perguntam "quer registrar mesmo assim?". | ✅ Vigente | Duas passadas no mesmo endpoint: a primeira não grava nada e devolve `409 ESTOQUE_INSUFICIENTE` com `result.faltantes`; a segunda leva `confirmar_estoque_insuficiente: true`, deixa o saldo negativo e gera alerta. `StatusEstoque` ganha `negativo`, distinto de `critico`. Regra é do backend — qualquer frontend só exibe o aviso. |
| **A6** | **Custo do item é média ponderada móvel**, não o último preço pago. | ✅ Vigente | Cada entrada recalcula `custo_medio`; `custo_ultima_compra` fica ao lado, informativo. Regra do backend. |
| **A7** | **Montar kit é operação real.** Kit tem saldo próprio (`quantidade_montada`). | ✅ Vigente | Montar consome insumo e passa pelo aviso de A5; vender **não** tem segunda passada — `KIT_NAO_MONTADO` é definitivo. Regra do backend. |
| **A8** | **Bundle id `br.com.thamiresbeauty.salao`**, nome de exibição "Thamires Beauty". | 🧊 Congelada (só Flutter, sem build nativo por ora) | `android/`/`ios/` continuam existindo em `salao_app`, mas não há mais trilha ativa para publicar nas lojas enquanto o frontend for só React. |
| **A9** | **Resumo é a entrada do app e segue o painel Lovable de 02/09/2026.** | ✅ Vigente (conceito) | Continua sendo a rota inicial: alerta, resultado mensal, histórico de seis meses, lucro por serviço, meta, próximos gastos e reposição. A implementação de navegação lateral/inferior é a reinventar em React — o conceito (menos itens de menu no mobile, mais no desktop) segue válido. |

### O que essas decisões apagam do estado atual

- `api/README.md` e o docstring de `api/app/main.py` dizem "CRUD puro → Supabase REST
  (frontend chama diretamente)". **Isso voltou a ser verdade com a reversão de A1** —
  só que hoje é o `salao_web`, não um FastAPI de CRUD puro, quem chama direto. Corrija
  a referência ao FastAPI quando encostar nesses arquivos.
- O `schema.sql` foi desenhado para RLS com a *anon key* do Supabase, pensando num
  cliente batendo direto — **é exatamente o que o `salao_web` faz hoje**. RLS
  (`auth.uid() = user_id`) é a autorização real, não uma segunda barreira atrás do
  FastAPI.

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

### Trilha React (nova, começando do zero)

- [x] **R0 — Padrão de projeto.** Ver `.specs/padrao-de-projeto-react.md`.
- [x] **R1 — Infra.** Cliente Supabase único (`lib/supabase.ts`), tokens do design
      system (Tailwind), layout responsivo (casca mobile/desktop), roteamento base.
- [x] **R2 — Módulo `auth`.**
- [x] **R3 — Demais módulos**, todos migrados para falar direto com o Supabase (branch
      `feat/react-supabase`), nesta ordem: Auth, Resumo, Atendimentos, Gastos, Estoque,
      Kits, Perfil, Servicos, Alertas, Agendamento_publico. Cada um foi verificado ponta
      a ponta contra o projeto Supabase real antes de passar para o próximo — ver
      "Reversão de A1" acima. `.specs/endpoints-backend.md` vale como registro do
      contrato de dados (nomes de campo, regras de negócio), não mais como endpoint a
      implementar num backend HTTP.

### Trilha backend (congelada — sem consumidor desde a reversão de A1)

- [ ] **F4 — Backend.** FastAPI implementando `.specs/endpoints-backend.md` ficou
      inacabado e **não é mais o caminho** — o `salao_web` não passa mais por ele. As
      dívidas conhecidas abaixo descrevem esse código parado; não são bloqueio de
      frontend.

### Dívidas conhecidas do backend (histórico — código sem consumidor)

- **Contrato de `gastos` diverge**: o app usa `forma_pagamento` ∈ {avista, credito,
  debito, pix} + `categoria` ∈ {material, fixo, outros}; o `schema.sql` usa
  {'à vista','cartão'} + `prioridade` ∈ {alta, média, baixa}. O mapa de endpoints
  define o contrato vencedor, e `001_v1_completo.sql` já converte os dados existentes.
- **`RelatorioMensal` (plano) ≠ `ResumoMensal` (API, aninhado)**. Vence o da API,
  estendido com os insights do protótipo (ticket médio, margem, comparativo com o mês
  anterior, serviço mais lucrativo).
- **`_extrair_user_id` decodifica o JWT sem verificar assinatura**
  (`api/app/routers/relatorio.py`). Com A1 isso é falha de segurança real: qualquer um
  forja um `sub`. É o lote **L0.2** de `pedidos-backend.md`, marcado 🔴 — validar com o
  `SUPABASE_JWT_SECRET`.
- **4 de poucos endpoints existem.** `pedidos-backend.md` é a lista do que falta, em
  ordem de dependência.

## Convenções de trabalho

- Domínio em **português** (`AtendimentoModel`/`Atendimento`, `getGastosPath`), nomes
  de infraestrutura/framework em **inglês**, seguindo o que o padrão Flutter já fazia —
  manter a mesma convenção em React. Texto de UI: sempre em pt-BR (mecanismo de
  tradução a decidir na trilha R0).
- Commits em português, como o histórico do repositório.
- Não invente contrato de API: se falta endpoint, ele entra em
  `.specs/endpoints-backend.md` antes de existir código que o chame — vale para
  qualquer frontend.
