# Mapa de endpoints — FastAPI

Especificação do backend que o frontend React consome. Consequência da **decisão A1**
([CLAUDE.md](../CLAUDE.md)): o FastAPI é o **único** backend que o app enxerga. O
Supabase é detalhe de implementação dele — o Flutter não fala PostgREST, não fala RPC,
não carrega `anon key`.

**Status de cada endpoint:**
`EXISTE` já implementado · `ALTERAR` existe mas muda · `NOVO` a implementar.

---

## 0. Contrato geral

### Base URL

Injetada por `--dart-define=API_BASE_URL=...`, nunca fixa no código.
Sugestão: `https://api.thamiresbeauty.com.br/v1`.

### Cabeçalhos

| Header | Quando | Valor |
|---|---|---|
| `Authorization` | toda requisição autenticada | `Bearer <token>` |
| `Accept-Language` | sempre | `pt-BR` |
| `Content-Type` | POST/PUT/PATCH | `application/json` |

### Envelope de resposta — obrigatório e uniforme

O padrão de projeto codifica o envelope **uma vez** em `ResponseModel`. Toda resposta,
sucesso ou erro, tem a mesma forma:

```json
{
  "total": 12,
  "mensagem": "ok",
  "codigo": null,
  "result": { }
}
```

| Campo | Tipo | Significado |
|---|---|---|
| `total` | `int` | quantidade de itens em `result` quando for lista; `1` para objeto; `0` em erro |
| `mensagem` | `string` | texto humano. Em erro, mensagem de fallback (o app prefere a tradução por código) |
| `codigo` | `string?` | **código de erro de negócio**. `null` em sucesso. Ver §9 |
| `result` | `object \| array \| null` | a carga útil |

Erro sai com o HTTP status apropriado **e** o mesmo envelope:

```json
{
  "total": 0,
  "mensagem": "Não há saldo em estoque para dar baixa neste item.",
  "codigo": "ESTOQUE_INSUFICIENTE",
  "result": null
}
```

> **Por que código e não texto:** o app identifica erro de negócio por `codigo`, nunca
> pela mensagem. Mensagem muda quando alguém corrige uma vírgula; código não. Todo
> código novo entra em §9 **e** ganha uma chave no ARB do app.

### Autorização

O servidor **deriva a usuária do token** e devolve só o que é dela. Nenhum endpoint
aceita `user_id` no corpo ou na query — se aceitar e confiar, é falha de servidor.

> ⚠️ **Dívida crítica de segurança.** `api/app/routers/relatorio.py::_extrair_user_id`
> decodifica o JWT em base64 **sem verificar a assinatura** e usa o `sub`. Enquanto o
> Flutter falava direto com o Supabase (RLS na anon key) isso era só feio; com A1 o
> FastAPI passa a ser a única barreira, e qualquer pessoa forja um token com o `sub` da
> usuária. Validar com `SUPABASE_JWT_SECRET` (python-jose) é pré-requisito de produção.

### Convenções

- Datas: ISO-8601. `date` puro (`2026-06-03`) para prazo; `datetime` com timezone para
  registro (`2026-06-03T14:30:00-03:00`).
- Dinheiro: `number` em reais com 2 casas (`180.00`). Nunca string, nunca centavos int.
  Todo campo de valor recebido em input aceita no máximo `1000000.00`.
- Identificadores: `uuid` string.
- Enums: **string**, nunca int (reordenar enum não pode ser quebra silenciosa).
- Paginação: `?pagina=1&tamanho=50` onde indicado; `total` no envelope é o total geral,
  não o da página.

---

## 1. `auth` — 4 operações

### `POST /auth/login` — `NOVO`

```json
// request
{ "email": "thamires@exemplo.com", "senha": "..." }
```
```json
// result
{
  "token": "eyJ...",
  "refresh_token": "eyJ...",
  "expira_em": 3600,
  "usuario": { "id": "uuid", "nome": "Thamires Borges", "email": "thamires@exemplo.com" },
  "salao": { "id": "uuid", "nome": "Thamires Borges Beauty", "foto_url": null }
}
```

Erros: `401` + `AUTH_CREDENCIAIS_INVALIDAS`. Se o Supabase Auth estiver
indisponível ou falhar sem indicar credencial recusada, responde `503` +
`AUTH_SERVICO_INDISPONIVEL`.

### `POST /auth/refresh` — `NOVO`

`{ "refresh_token": "..." }` → mesmo `result` do login (token + refresh novos).
Erros: `401` + `AUTH_REFRESH_INVALIDO` (o app faz logout).

O interceptor do Dio chama este endpoint **antes** de deslogar, em `QueuedInterceptor`
para não disparar N refreshes simultâneos.

### `POST /auth/logout` — `NOVO`

Sem corpo. Invalida o refresh token. `result: null`.

### `GET /auth/eu` — `NOVO`

Dados da sessão corrente (`usuario` + `salao`). Usado no boot para revalidar token e
repopular o cabeçalho sem esperar as telas.

---

## 2. `atendimentos` — 7 operações

Status: `agendado` · `finalizado` · `cancelado`.
Cancelado **não** entra em nenhum cálculo financeiro.

### `GET /atendimentos` — `NOVO`

Query: `inicio` (date), `fim` (date), `status` (opcional, csv), `pagina`, `tamanho`.

> O `status` **é consumido pelo app** desde o filtro da tela de atendimentos: ele não é
> opcional na prática. Filtrar no servidor e não na lista já baixada é o que faz
> `saldo_liquido` e `quantidade` baterem com os cartões na tela.

```json
// result — o agregado vem junto porque o cabeçalho verde da tela precisa dele
{
  "saldo_liquido": 430.00,
  "quantidade": 3,
  "atendimentos": [
    {
      "id": "uuid",
      "cliente_nome": "Maria",
      "cliente_telefone": "+5511999887766",
      "data": "2026-08-31T10:00:00-03:00",
      "status": "finalizado",
      "servicos": [
        { "servico_id": "uuid", "nome": "Extensão de cílios", "preco": 180.00 }
      ],
      "materiais": [
        { "item_estoque_id": "uuid", "nome": "Fio mink 0.07", "quantidade": 1, "preco": 35.00 }
      ],
      "total_servicos": 180.00,
      "total_materiais": 35.00,
      "saldo": 145.00,
      "custo_estimado": null,
      "saldo_estimado": null
    }
  ]
}
```

> `total_servicos`, `total_materiais`, `saldo`, `custo_estimado` e `saldo_estimado` vêm
> **calculados do servidor**. Hoje o
> app calcula com getters no model; passa a só exibir. Motivo: a mesma conta alimenta o
> resumo, o alerta e o n8n — três lugares onde não pode divergir.

Para atendimento `agendado`, `custo_estimado` e `saldo_estimado` usam a composição
atual dos serviços e o `custo_medio` atual do estoque. São uma previsão visual: não
baixam estoque, não entram nos totais financeiros e podem mudar até a finalização. Em
`finalizado` e `cancelado`, ambos são `null`; o custo real é `total_materiais`.

### `POST /atendimentos` — `NOVO`

Cria **agendado**. Materiais não entram aqui (só na finalização).

```json
{
  "cliente_nome": "Fernanda",
  "cliente_telefone": "+5511988887777",
  "data": "2026-09-03T14:00:00-03:00",
  "servicos": [{ "servico_id": "uuid" }]
}
```

O preço vem da tabela de serviços do salão e é **congelado como snapshot** no
atendimento — mudar o preço no perfil não pode reescrever o histórico. Serviço avulso
(sem cadastro) é aceito como `{ "nome": "...", "preco": 90.00 }`.

### `GET /atendimentos/{id}` — `NOVO`
### `PATCH /atendimentos/{id}` — `NOVO`

Edita cliente, data e serviços. Aceita **agendado e finalizado**; cancelado recusa com
`409` + `ATENDIMENTO_STATUS_INVALIDO`.

```json
{
  "cliente_nome": "Fernanda",
  "cliente_telefone": "+5511988887777",
  "data": "2026-09-03T14:00:00-03:00",
  "servicos": [{ "servico_id": "uuid" }]
}
```

> **Por que finalizado também edita.** Corrigir o nome do cliente ou o serviço lançado
> num atendimento que já aconteceu é o caso comum — errar o nome só aparece depois. O
> que continua fechado é **cancelado**: registro fora das contas do mês não se
> reescreve. Materiais **não** entram neste corpo: quem mexe em material é
> `/finalizar`, a operação que dá baixa no estoque — editar nunca move saldo de item.
> O preço do catálogo é congelado de novo, igual ao `POST`.

### `PATCH /atendimentos/{id}/finalizar` — `NOVO`

```json
{
  "materiais": [
    { "item_estoque_id": "uuid", "quantidade": 1 },
    { "nome": "Fita micropore", "quantidade": 2, "preco": 8.00 }
  ],
  "confirmar_estoque_insuficiente": false
}
```

**Regra de negócio que mora aqui, no servidor:** finalizar dá **baixa no estoque** de
cada material com `item_estoque_id`, gerando uma `movimentacao` do tipo `saida` com
`atendimento_id` preenchido, e recalcula os alertas de estoque. O preço do material é o
`custo_medio` do item no momento da baixa (snapshot — ver §5).

**De onde vem essa lista:** o app abre a finalização com um modal de confirmação de
consumo já preenchido pelos `produtos_padrao` dos serviços do atendimento (§8) —
somando as quantidades quando dois serviços pedem o mesmo item. A usuária ajusta o que
saiu a mais ou a menos, remove o que não usou e acrescenta o que usou fora do padrão.
O corpo é sempre o **estado final** dessa conferência, nunca a diferença em relação ao
padrão: o servidor não deduz consumo, ele grava o que foi confirmado.

#### Estoque insuficiente: avisar e perguntar — `DECIDIDO`

Duas passadas, **no mesmo endpoint**, controladas por `confirmar_estoque_insuficiente`:

**1ª passada** — o app sempre manda `false`. Se falta saldo de qualquer material, o
servidor **não grava nada** (nem o status, nem as movimentações) e devolve `409`:

```json
{
  "total": 0,
  "mensagem": "Alguns materiais estão sem saldo em estoque.",
  "codigo": "ESTOQUE_INSUFICIENTE",
  "result": {
    "faltantes": [
      {
        "item_estoque_id": "uuid",
        "nome": "Cola adesiva para cílios",
        "unidade": "un",
        "quantidade_solicitada": 2,
        "quantidade_disponivel": 0,
        "deficit": 2
      }
    ]
  }
}
```

**2ª passada** — o app mostra o aviso com essa lista e o botão *Finalizar mesmo assim*.
Se ela confirmar, repete a chamada idêntica com `confirmar_estoque_insuficiente: true`:
o servidor finaliza, grava as movimentações normalmente, **deixa o saldo negativo** e
gera um alerta `estoque_negativo` por item afetado.

> **Por que não bloquear.** Ela repõe depois de atender, não antes. Bloquear travaria o
> registro do atendimento — o dado que sustenta todo o resumo financeiro — por causa de
> um controle de estoque desatualizado. Saldo negativo é feio e visível, que é
> exatamente o efeito desejado: aparece em vermelho na tela de Estoque e vira alerta até
> ela repor.

`confirmar_estoque_insuficiente: true` libera **só a checagem de saldo**. Status inválido,
material inexistente e corpo malformado continuam recusando.

#### Consistência da operação — etapa 4

A finalização é uma única transação no banco: ela trava o atendimento e os itens
envolvidos, grava insumos, movimentações, custos e alertas, e só então altera o
status para `finalizado`. Dois envios simultâneos do mesmo atendimento resultam em
uma única baixa; o outro recebe `409` + `ATENDIMENTO_STATUS_INVALIDO`. Qualquer
falha em uma das gravações desfaz todas as demais, inclusive os saldos já calculados.

Erros: `409` + `ESTOQUE_INSUFICIENTE` (1ª passada) · `409` +
`ATENDIMENTO_STATUS_INVALIDO` · `404` + `RECURSO_NAO_ENCONTRADO`.

### `PATCH /atendimentos/{id}/cancelar` — `NOVO`

Se já estava finalizado, **estorna** as movimentações de estoque. `result` com o
atendimento atualizado. O estorno acontece na mesma transação que muda o status:
devolve cada saída original uma única vez, registra o histórico de estorno e resolve
o alerta negativo criado por aquela finalização. Um segundo cancelamento recebe
`409` + `ATENDIMENTO_STATUS_INVALIDO` e não devolve material outra vez.

### `DELETE /atendimentos/{id}` — `NOVO`

Só para agendado. Finalizado se cancela, não se apaga (histórico financeiro).

---

## 3. `gastos` — 5 operações

**Contrato vencedor** (o `schema.sql` se ajusta a ele, não o contrário):

| Campo | Valores |
|---|---|
| `forma_pagamento` | `a_vista` · `credito` · `debito` · `pix` |
| `categoria` | `fixo` · `material` · `outros` |

O campo `prioridade` (`alta`/`média`/`baixa`) do `schema.sql` **sai** — não aparece no
protótipo e não alimenta nenhum cálculo. Urgência é derivada do prazo.

### `GET /gastos` — `NOVO`

Query: `mes`, `ano`, `pago` (bool, opcional), `categoria`, `pagina`, `tamanho`.

```json
{
  "total_pendente": 246.80,
  "total_pago_mes": 210.00,
  "gastos": [
    {
      "id": "uuid",
      "nome": "Conta de luz",
      "valor": 120.00,
      "prazo_pagamento": "2026-09-03",
      "forma_pagamento": "pix",
      "categoria": "fixo",
      "pago": false,
      "pago_em": null,
      "vence_em_dias": 1,
      "itens": [{ "nome": "...", "preco": 0.00 }]
    }
  ]
}
```

`vence_em_dias` vem do servidor (negativo = vencido). O app não recalcula prazo — é a
mesma regra que gera o alerta.

### `POST /gastos` — `NOVO`
### `PATCH /gastos/{id}` — `NOVO`
### `PATCH /gastos/{id}/pagar` — `NOVO`

Corpo opcional `{ "pago_em": "2026-09-02" }`; ausente = hoje.
Idempotente: gasto já pago devolve `200` com o estado atual, **não** erro.

### `DELETE /gastos/{id}` — `NOVO`

---

## 4. `resumo` — 3 operações

### `GET /resumo/mensal?ano&mes` — `ALTERAR`

Existe como `GET /relatorio/mensal`. Muda de nome (alinha com o módulo do app) e
**ganha os insights do protótipo**, que hoje não existem em lugar nenhum:

```json
{
  "ano": 2026, "mes": 8,
  "saldo_final": 1240.00,
  "entrou": 2985.00,
  "saiu": 1745.00,
  "meta_faturamento_mensal": 9000.00,
  "historico_seis_meses": [
    { "ano": 2026, "mes": 3, "receitas": 2100.00, "despesas": 1700.00 },
    { "ano": 2026, "mes": 8, "receitas": 2985.00, "despesas": 1745.00 }
  ],
  "receita": {
    "total_servicos": 2985.00,
    "total_insumos": 397.00,
    "liquido_atendimentos": 2588.00,
    "quantidade_atendimentos": 18,
    "total_kits": 135.00,
    "quantidade_kits_vendidos": 3,
    "custo_kits_vendidos": 64.50,
    "servicos_mais_realizados": [
      { "nome": "Extensão de cílios", "quantidade": 2, "total_receita": 360.00, "lucro": 290.00 }
    ]
  },
  "gastos": {
    "total_custos_fixos": 1348.00,
    "total_gastos_variaveis": 397.00,
    "total_saiu": 1745.00
  },
  "insights": {
    "ticket_medio": 165.00,
    "margem_lucro_percentual": 41.5,
    "variacao_percentual_mes_anterior": 18.0,
    "saldo_mes_anterior": 1050.00,
    "servico_mais_lucrativo": { "nome": "Extensão de cílios", "lucro": 290.00 }
  },
  "alerta_zero_a_zero": false,
  "comparacao": {
    "periodo_atual": "2026-08",
    "periodo_anterior": "2026-07",
    "faturamento": { "atual": 2985.00, "anterior": 2500.00, "variacao_percentual": 19.4 },
    "gastos": { "atual": 1745.00, "anterior": 1600.00, "variacao_percentual": 9.06 },
    "lucro": { "atual": 1240.00, "anterior": 900.00, "variacao_percentual": 37.78 }
  }
}
```

Campos novos em relação ao que a API devolve hoje: `saldo_final` no topo, `entrou`,
`saiu`, `meta_faturamento_mensal`, `historico_seis_meses`, o bloco `insights` inteiro,
`lucro` em cada item de `servicos_mais_realizados` e os três campos de kit dentro de
`receita`. O histórico sempre contém seis posições em ordem cronológica, inclusive
meses sem movimento (valores zero), para o gráfico não deslocar os rótulos.

`servicos_mais_realizados[].lucro = total_receita - soma(custo_insumos_snapshot)`.
Ao finalizar o atendimento, o servidor calcula e congela
`atendimento_servicos.custo_insumos_snapshot` usando a composição padrão e o
`custo_medio` vigente. Alterar preço, composição ou custo depois não reescreve meses
fechados.

**Onde a venda de kit entra na conta** (§6): `entrou = total_servicos + total_kits`. O
custo do kit **não** entra em `saiu` — ele já saiu quando o insumo foi comprado, e contar
de novo na venda seria contar duas vezes. `custo_kits_vendidos` está no payload só para a
margem: é informativo, não entra em nenhuma soma do saldo.

`ticket_medio` continua sendo `total_servicos ÷ quantidade_atendimentos` — kit não é
atendimento e diluiria o número que ela usa para decidir preço.

> O model Flutter atual (`RelatorioMensal`, plano) **não** bate com este payload
> aninhado. Vence este; o model é reescrito na F3.

### `GET /resumo/anual?ano` — `NOVO`

Retorna a consolidação dos doze meses do ano selecionado. O payload mantém os blocos
`receita`, `gastos` e `insights` do resumo mensal, troca a meta por
`meta_faturamento_anual` e entrega `historico_doze_meses` para o gráfico anual.
`comparacao` usa o ano anterior e possui o mesmo formato da comparação mensal:

```json
{
  "ano": 2026,
  "saldo_final": 12400.00,
  "entrou": 29850.00,
  "saiu": 17450.00,
  "meta_faturamento_anual": 108000.00,
  "historico_doze_meses": [
    { "ano": 2026, "mes": 1, "receitas": 2100.00, "despesas": 1700.00 }
  ],
  "comparacao": {
    "periodo_atual": "2026",
    "periodo_anterior": "2025",
    "faturamento": { "atual": 29850.00, "anterior": 25000.00, "variacao_percentual": 19.4 },
    "gastos": { "atual": 17450.00, "anterior": 16000.00, "variacao_percentual": 9.06 },
    "lucro": { "atual": 12400.00, "anterior": 9000.00, "variacao_percentual": 37.78 }
  }
}
```

Quando o período anterior não possui valor, `variacao_percentual` é `null` e a tela
mostra que ainda não há base para comparação. Isso evita tratar um primeiro movimento
como crescimento de uma porcentagem arbitrária.

### `POST /precificacao/calcular` — `EXISTE`

Mantido como está. É cálculo puro, não toca no banco.
Migra de `/precificacao/calcular` para dentro do módulo `resumo` no app, sem mudar o
path no servidor.

---

## 5. `estoque` — 6 operações

Módulo dividido de `kits` porque juntos passariam de 8 operações.

As seis operações abaixo estão implementadas no FastAPI; o frontend React fala somente
com elas, pela base URL única do app.

Tabelas a criar: `estoque_itens`, `estoque_movimentacoes`, `kits`, `kit_itens`.

### `GET /estoque/itens` — `NOVO`

Query: `status` (`ok`/`alerta`/`critico`/`negativo`), `categoria`, `ativo`, `codigo_barras`.

Além de `itens`, a resposta inclui `planejamento_reposicao`: uma lista somente de
leitura para os próximos 30 dias. Para cada item que precisa ser comprado, o servidor
informa o saldo na unidade natural (`un` ou `uso`), a média de saídas dos últimos 30
dias, o consumo dos atendimentos agendados e a quantidade sugerida. A sugestão nunca
altera rendimento, mínimo, estoque ou Gastos; ela apenas explica a base da decisão.

```json
{
  "total_alertas": 3,
  "valor_total": 428.50,
  "itens": [
    {
      "id": "uuid",
      "nome": "Cola adesiva para cílios",
      "unidade": "un",
      "categoria": "cilios",
      "quantidade_atual": 0,
      "quantidade_minima": 2,
      "custo_medio": 28.00,
      "custo_ultima_compra": 30.00,
      "status": "critico",
      "deficit": 2,
      "ativo": true,
      "codigo_barras": null,
      "modo_controle": "quantidade",
      "usos_por_unidade": null,
      "usos_minimos": 0,
      "usos_disponiveis": null,
      "custo_por_uso": null,
      "deficit_usos": null,
      "status_rendimento": null
    }
  ]
}
```

`status` e `deficit` vêm do **servidor** (S7 da adaptação): `negativo` quando
`quantidade_atual < 0`, `critico` quando `== 0`, `alerta` quando
`<= quantidade_minima`, senão `ok`. O app não recalcula — a mesma regra alimenta o push
e o n8n.

`negativo` existe por causa da decisão de finalizar atendimento sem saldo (§2): o estado
tem que ser visível e distinto de "acabou", senão ela não sabe que deve **mais** do que
zero ao repor.

`unidade` ∈ `un` · `ml` · `g` · `cx`.
`categoria` ∈ `cilios` · `sobrancelha` · `limpeza_pele` · `micropigmentacao` ·
`reconstrucao` · `descartavel` · `outro`.

#### Rendimento por usos — `DECIDIDO` (07/09/2026, etapa 2 do estoque)

Um produto compartilhado pode ser acompanhado por sua **capacidade total de
usos**, sem perguntar quando um pote foi aberto. Exemplo: 6 potes que rendem 10
usos cada mostram 60 usos; um serviço que usa 1 uso passa a mostrar 59.

- `modo_controle = "rendimento_usos"` exige `unidade = "un"`,
  `usos_por_unidade > 0` e `usos_minimos >= 0`.
- `quantidade_atual` continua sendo a quantidade de embalagens. Para esse modo,
  pode ficar fracionária internamente: 59 usos de potes que rendem 10 = 5,9
  unidades. A API devolve `usos_disponiveis`, `custo_por_uso`,
  `deficit_usos` e `status_rendimento` já calculados; a tela não refaz contas.
- `servico_produtos_padrao[].quantidade` e
  `atendimentos/{id}/finalizar.materiais[].quantidade` significam **usos**
  para esse modo. Nos demais modos, continuam na unidade física do item.
- Cada uso baixa `1 ÷ usos_por_unidade` da quantidade física e usa
  `custo_medio ÷ usos_por_unidade` no custo do atendimento. Compra acrescenta
  embalagens e recalcula a média ponderada como antes; não reinicia consumo.
- O alerta usa `usos_minimos`, com os mesmos estados `ok`/`alerta`/`critico`/
  `negativo`. Falta de estoque devolve usos em `result.faltantes` e respeita
  as duas passadas da A5.

Exemplo de criação:

```json
{
  "nome": "Creme facial",
  "unidade": "un",
  "categoria": "limpeza_pele",
  "quantidade_atual": 6,
  "quantidade_minima": 0,
  "custo_unitario": 50.00,
  "modo_controle": "rendimento_usos",
  "usos_por_unidade": 10,
  "usos_minimos": 10
}
```

Resposta resumida:

```json
{
  "quantidade_atual": 6,
  "usos_por_unidade": 10,
  "usos_disponiveis": 60,
  "custo_por_uso": 5.00,
  "usos_minimos": 10,
  "status_rendimento": "ok"
}
```

#### Encerramento dos controles de duração — `DECIDIDO` (07/09/2026, etapa 3)

Só existem dois modos: `quantidade` e `rendimento_usos`. O sistema não usa uma data de
abertura, não trata estimativa como validade e não oferece ação de abrir pote. A migração
`013_encerrar_controles_legados.sql`, aplicada depois da 012, converte o que restou em
`validade_*` para `quantidade` sem mudar saldo, custo, composição de kit ou histórico.
Itens em ml/g/caixa e itens de kit ficam em saldo físico até uma conferência informar um
rendimento confiável. Os alertas de validade ainda existentes são resolvidos e preservados
somente como histórico.

#### Bipagem de código de barras — `DECIDIDO`

`codigo_barras` é opcional e único por usuário (nulo não conta como duplicado — vários
itens podem não ter código nenhum). A câmera do celular lê o código (sem leitor físico
dedicado); o app não fala com o banco diretamente para isso — o fluxo é só um `GET
/estoque/itens?codigo_barras=...` seguido de `POST` (código novo, ela cadastra o item na
mão, já com o código preenchido) ou `POST .../movimentacoes` do tipo `entrada` (código
já conhecido, ela confirma o item e a quantidade que está entrando). Não existe endpoint
dedicado de "bipar" — é reaproveitamento do filtro de listagem, para não estourar as 6
operações do módulo.

`POST`/`PATCH` com um `codigo_barras` já usado por outro item (do mesmo usuário): `409` +
`CODIGO_BARRAS_JA_CADASTRADO`.

### `POST /estoque/itens` — `NOVO`
### `PATCH /estoque/itens/{id}` — `NOVO`
### `DELETE /estoque/itens/{id}` — `NOVO`

Soft delete (`ativo = false`) quando o item já tem movimentação — apagar quebraria o
histórico de custo dos atendimentos.

`POST`/`PATCH` aceitam `modo_controle`, `usos_por_unidade` e `usos_minimos`.
`modo_controle` omitido vale `"quantidade"`. Em `rendimento_usos`, a unidade física é
obrigatoriamente `un` e o saldo começa no próprio cadastro; não há abertura de pote.
Campos ou modos legados de duração retornam `422`.

Ao cadastrar um item com saldo inicial maior que zero, o servidor calcula automaticamente
o gasto como `custo_unitario × quantidade_atual` e cria um lançamento da categoria
`material`, com vencimento no dia da entrada e forma de pagamento `a_vista`. O lançamento
nasce pendente, como os demais gastos, e pode ser marcado como pago na tela de Gastos.
Se o custo unitário ou a quantidade resultar em zero, não cria gasto.

Ao editar um produto, saldo e custo não mudam: a tela usa conferência ou entrada para
isso, preservando o histórico. A mudança de `quantidade` para `rendimento_usos` só é
aceita para itens que já estão contados em `un`. Em ml, gramas ou caixas, o cliente
precisa enviar `confirmar_unidade_fisica: true` depois de conferir que o saldo atual já
representa embalagens; assim o servidor jamais converte ou reinterpreta a quantidade
automaticamente. Enviar `codigo_barras: null` remove um código antes vinculado ao produto.

### `POST /estoque/itens/{id}/movimentacoes` — `NOVO`

```json
{ "tipo": "entrada", "quantidade": 10, "motivo": "Compra — fornecedor",
  "custo_unitario": 28.00 }
```

`tipo` ∈ `entrada` · `saida` · `ajuste`. Devolve o item com a quantidade e o custo já
atualizados.

**Semântica das movimentações manuais (etapa 1 do roadmap, 07/09/2026):**

- `entrada`: acrescenta `quantidade` ao saldo; deve ser finita e maior que zero.
- `saida`: subtrai `quantidade`; deve ser finita e maior que zero. Saldo
  insuficiente retorna `409 ESTOQUE_INSUFICIENTE`, sem gravar.
- `ajuste`: conferência física. `quantidade` é o **saldo final contado**, finito
  e maior ou igual a zero, nunca um incremento. Saldo 6 + contagem 4 resulta
  em 4; contagem 0 resulta em 0. Não altera custo.
- `custo_unitario`, quando informado, deve ser finito e não negativo.
- Em uma `entrada`, quando `custo_unitario` for informado, o servidor calcula o gasto
  automaticamente como `custo_unitario × quantidade` e cria um lançamento de `material`
  com a descrição baseada no produto e no motivo da entrada. O lançamento nasce pendente
  e usa a data atual como prazo. `saida` e `ajuste` não geram gasto.
- A conferência grava saldo e histórico na mesma transação, com o dono derivado
  da sessão. A migração `011_conferencia_estoque.sql` deve preceder o backend.
  Ela não modifica o RPC incremental usado por atendimentos, kits e estornos.

Para `rendimento_usos`, as movimentações manuais continuam recebendo embalagens na
`quantidade` física. As baixas produzidas ao finalizar atendimento registram também
`quantidade_consumida` e `unidade_consumo = "uso"`, preservando ao mesmo tempo a
fração de embalagem e o consumo lógico no histórico.

Na conferência de um item por rendimento, a tela pode somar embalagens completas e
os usos restantes da embalagem em andamento. Ela converte essa contagem para a fração
física em `quantidade` antes de chamar este endpoint: por exemplo, 4 embalagens e 3
usos de um pote que rende 10 viram `4.3`. O servidor continua tendo um único saldo e
uma única operação de conferência.

```json
{ "tipo": "ajuste", "quantidade": 0, "motivo": "Conferência de estoque" }
```

No histórico (`GET /estoque/movimentacoes`), novas conferências retornam também
`saldo_anterior` e `saldo_atual` (ex.: `6` e `0`). `quantidade` guarda o saldo
contado. Esses campos são nulos nos registros antigos e nas demais operações;
não reinterpretar ajustes antigos ou estornos como contagens absolutas.

#### Custo do item: média ponderada móvel — `DECIDIDO`

Toda `entrada` que traz `custo_unitario` recalcula o custo do item:

```
custo_medio_novo = (saldo_atual × custo_medio_atual + qtd_entrada × custo_unitario)
                   ÷ (saldo_atual + qtd_entrada)
```

Se `saldo_atual <= 0`, não há o que ponderar: `custo_medio_novo = custo_unitario`.
`saida` e `ajuste` **nunca** mexem no custo — só no saldo.

O item guarda os dois valores:

| Campo | Para que serve |
|---|---|
| `custo_medio` | margem do kit, custo do atendimento, valor total do estoque |
| `custo_ultima_compra` | informativo — quanto ela pagou na última vez |

> **Por que média e não último preço.** Com "último preço", uma única compra cara ou
> promocional reescreve o custo de todo o saldo parado, e a margem do mês salta sem que
> nada de real tenha mudado. A média move o custo na proporção do que entrou: comprar
> 2 unidades caras sobre 20 baratas quase não mexe no número, que é o comportamento
> correto. É também o critério contábil usual no Brasil (custo médio ponderado móvel).

Saída manual que deixaria o saldo negativo: `409` + `ESTOQUE_INSUFICIENTE`, com o mesmo
`result.faltantes` da finalização. A movimentação avulsa **não** tem confirmação em duas
passadas: negativo só entra pelo caminho do atendimento, onde há um fato real por trás.

### `GET /estoque/movimentacoes` — `NOVO`

Query: `item_id`, `inicio`, `fim`, `tipo`, `pagina`, `tamanho`.
Alimenta o histórico (ícone de relógio na app bar de Estoque).

```json
{ "movimentacoes": [
  { "id": "uuid", "item_id": "uuid", "item_nome": "Cola adesiva para cílios",
    "tipo": "saida", "quantidade": 1, "motivo": "Atendimento — Maria",
    "atendimento_id": "uuid", "criado_em": "2026-08-31T10:40:00-03:00" }
] }
```

---

## 6. `kits` — 6 operações

Kit de revenda: um produto **montado a partir do estoque que ela já tem** e vendido
avulso, fora do atendimento.

`GET /kits` é o cadastro (a *receita* do kit). Montar e vender são dois fatos separados,
porque acontecem em momentos diferentes: ela monta cinco kits numa tarde e vende ao longo
das semanas seguintes. Por isso o kit tem saldo próprio — `quantidade_montada`.

```
estoque de insumos  ──montar──▶  kits montados  ──vender──▶  receita
```

### `GET /kits` — `NOVO`

```json
{ "kits": [
  { "id": "uuid", "nome": "Kit cuidado pós-cílios", "preco_venda": 45.00,
    "custo_total": 21.50, "margem": 23.50,
    "quantidade_montada": 3,
    "quantidade_montavel": 7,
    "disponivel": true,
    "itens": [
      { "item_estoque_id": "uuid", "nome": "Removedor", "quantidade": 1, "unidade": "un" },
      { "item_estoque_id": "uuid", "nome": "Fita micropore", "quantidade": 2, "unidade": "cx" }
    ] }
] }
```

Tudo que é derivado é do servidor:

| Campo | Cálculo |
|---|---|
| `custo_total` | Σ (`quantidade` do item × `custo_medio` do item) |
| `margem` | `preco_venda − custo_total` |
| `quantidade_montada` | saldo de kits prontos, na prateleira |
| `quantidade_montavel` | `min(saldo_item ÷ quantidade_item)` sobre os itens — quantos ainda dá para montar |
| `disponivel` | `quantidade_montada > 0 || quantidade_montavel > 0` |

### `POST /kits` — `NOVO`
### `PATCH /kits/{id}` — `NOVO`
### `DELETE /kits/{id}` — `NOVO`

Soft delete (`ativo = false`) se o kit já tem venda ou montagem — apagar quebraria o
histórico de receita.

### `POST /kits/{id}/montar` — `NOVO`

```json
{ "quantidade": 2, "confirmar_estoque_insuficiente": false }
```

Baixa `quantidade × quantidade_item` de **cada** item da composição, gerando uma
`movimentacao` de `saida` por item com `kit_id` preenchido e motivo `Montagem de kit`, e
soma `quantidade` em `quantidade_montada`. Operação **atômica**: ou baixa todos os itens,
ou nenhum. A composição, os saldos e o saldo montado do kit são travados na mesma
transação, portanto uma falha não deixa insumo baixado sem kit montado.
`quantidade` é um inteiro positivo: kits são montados e vendidos em unidades inteiras.

Mesma mecânica de duas passadas da finalização (§2): sem saldo, `409` +
`ESTOQUE_INSUFICIENTE` com `result.faltantes`; se ela confirmar, monta e deixa o saldo
negativo.

`result`: o kit atualizado.

### `POST /kits/{id}/vender` — `NOVO`

```json
{ "quantidade": 1, "preco_unitario": 45.00, "forma_pagamento": "pix",
  "data": "2026-09-02T15:20:00-03:00" }
```

Decrementa `quantidade_montada` e grava a venda com **snapshot** de `preco_unitario` e
`custo_total` (o kit pode mudar de preço depois; a venda de ontem não muda). `data` é
opcional — ausente vale `now()`.

`preco_unitario` também é opcional: ausente, vale o `preco_venda` do cadastro. Existe
para o desconto de balcão, que acontece.

Vender mais do que está montado: `409` + `KIT_NAO_MONTADO`, com
`result: { "quantidade_montada": 1, "quantidade_solicitada": 3 }`. **Aqui não há
confirmação em duas passadas** — não existe "vender um kit que não existe"; ela monta e
vende. É diferente do estoque de insumo, onde o negativo representa um consumo real que
já aconteceu.

`forma_pagamento` usa a mesma lista de `gastos`: `a_vista` · `credito` · `debito` · `pix`.

> **Impacto no resumo (§4):** a venda de kit é receita e precisa aparecer no mês. Ver o
> bloco `receita.kits` acrescentado lá.

---

## 7. `perfil` — 11 operações

### `GET /perfil` — `NOVO`
### `PUT /perfil` — `NOVO`

```json
{ "salao": { "id": "uuid", "nome": "Thamires Borges Beauty",
             "proprietaria": "Thamires Borges", "foto_url": null,
             "telefone_whatsapp": "+5511999999999",
             "instagram_url": "@thamiresbeauty",
             "endereco": "Rua Exemplo, 123 — São Paulo, SP",
             "descricao_publica": "Especialista em cílios e sobrancelhas.",
             "meta_faturamento_mensal": 9000.00 } }
```

`PUT /perfil` aceita `meta_faturamento_mensal`; o Resumo usa essa meta para calcular
o percentual alcançado. O `telefone_whatsapp` e o `limite_gasto_alerta` que hoje vivem no mock do ApiService
migram: o telefone fica aqui, o limite vai para as **preferências de alerta** (§8).

`foto_url`, `telefone_whatsapp`, `instagram_url`, `endereco` e `descricao_publica` são a
apresentação pública do salão no link de agendamento (§10). Todos são opcionais e a
profissional os edita na tela Perfil; endereço e Instagram não entram em cálculos financeiros.

### `POST /perfil/foto` — `NOVO`

Recebe `multipart/form-data` com o campo `arquivo` e devolve:

```json
{ "foto_url": "https://<projeto>.supabase.co/storage/v1/object/public/fotos-salao/saloes/<user_id>/perfil" }
```

Aceita somente JPEG, PNG e WebP, até **5 MB**. O FastAPI valida o tipo declarado e a
assinatura do arquivo, grava em `fotos-salao/saloes/<user_id>/perfil` com a service role e
devolve a URL pública; o navegador nunca acessa o Supabase Storage diretamente. A tela exibe
a prévia retornada e só persiste `foto_url` no perfil quando a profissional salva os dados.

### `GET /perfil/custos-fixos` — `NOVO`

Aceita `?competencia=2026-09`; sem ela, vale o **mês corrente**.

```json
{ "total_mensal": 1348.00,
  "total_pago": 1200.00,
  "total_pendente": 148.00,
  "custos": [{ "id": "uuid", "descricao": "Aluguel", "valor": 1200.00,
               "dia_vencimento": 5, "competencia": "2026-09",
               "pago": true, "pago_em": "2026-09-03T10:12:00Z" }] }
```

`pago` **não é campo do cadastro**: é o estado daquele custo *naquela
competência*, resolvido pelo servidor a partir de `custos_fixos_pagamentos`. O
mesmo aluguel volta com `pago: true` em setembro e `pago: false` em outubro sem
que ninguém desmarque nada — é o que faz o custo fixo se comportar como
compromisso recorrente, e não como lançamento.

Os dois totais vêm somados do servidor: o app não soma lista.

### `POST /perfil/custos-fixos` — `NOVO`
### `PATCH /perfil/custos-fixos/{id}` — `NOVO`

Mesmo corpo nos dois; o `PATCH` substitui os três campos.

```json
{ "descricao": "Aluguel", "valor": 1200.00, "dia_vencimento": 5 }
```

`dia_vencimento` é **inteiro de 1 a 31 e obrigatório** — fora da faixa,
`422 VALIDACAO_INVALIDA`. Guarda-se o dia literal que a usuária escolheu, não uma
data: "todo dia 31" continua sendo dia 31 em fevereiro, e quem agenda o aviso é que
resolve o mês curto (último dia do mês). Sem ele um custo fixo é só uma parcela do
total — não dá para avisar que vence amanhã nem para ordenar o mês.

Custo fixo cadastrado antes deste campo existir volta com `dia_vencimento: 1`, que é
o default da coluna.

### `DELETE /perfil/custos-fixos/{id}` — `NOVO`

Apaga junto o histórico de pagamento do custo (`on delete cascade`).

### `PATCH /perfil/custos-fixos/{id}/pagar` — `NOVO`

```json
{ "competencia": "2026-09", "pago": true }
```

Marca (ou desmarca) o pagamento de **uma competência**. É idempotente: pagar
duas vezes o mesmo mês não duplica nada — `unique (custo_fixo_id, competencia)`.

- `competencia` fora do formato `AAAA-MM` → `422 VALIDACAO_INVALIDA`.
- `pago: false` remove a marcação e devolve o custo para pendente. Desmarcar é
  tão necessário quanto marcar: um toque errado no celular não pode calar o
  alerta do aluguel pelo mês inteiro.
- **Pagar não lança gasto.** Custo fixo já entra no resultado do mês pelo
  perfil; criar um `gasto` aqui contaria o aluguel duas vezes.

### `GET /perfil/horario-funcionamento` — `NOVO`
### `PUT /perfil/horario-funcionamento` — `NOVO`

Base do cálculo de horário livre do agendamento público (§10). Decisão do dono do
projeto: **cada dia da semana tem seu próprio horário**, não um expediente único
repetido — é o que permite "funciono seg-sex mas sábado só de manhã, domingo fechado".

```json
{
  "horarios": [
    { "dia_semana": 0, "ativo": false, "hora_inicio": null, "hora_fim": null,
      "hora_inicio_2": null, "hora_fim_2": null },
    { "dia_semana": 1, "ativo": true,  "hora_inicio": "08:00", "hora_fim": "12:00",
      "hora_inicio_2": "13:00", "hora_fim_2": "18:00" },
    { "dia_semana": 2, "ativo": true,  "hora_inicio": "09:00", "hora_fim": "19:00",
      "hora_inicio_2": null, "hora_fim_2": null }
  ]
}
```

`dia_semana`: `0` domingo … `6` sábado. O `PUT` **substitui os 7 dias de uma vez** —
mesma filosofia do `PATCH /servicos/{id}` com `produtos_padrao`: o cliente manda o
estado final da tela (um toggle + primeiro turno + segundo turno opcional), o servidor
não faz diff. Dia com `ativo: false` não abre horário nenhum e todas as horas são
zeradas. O segundo turno é opcional, mas `hora_inicio_2` e `hora_fim_2` devem vir
juntas; ele começa no mesmo instante ou depois de `hora_fim`, nunca se sobrepõe ao
primeiro.

`hora_inicio`/`hora_fim` obrigatórios e `hora_inicio < hora_fim` quando `ativo: true`;
o mesmo vale para o segundo turno quando existir, senão `422 VALIDACAO_INVALIDA`.
**Não há exceção por data** (feriado, folga pontual) nesta versão — é dia da semana
fixo. Se isso virar necessário, entra depois como uma tabela de bloqueios pontuais;
não faz parte do escopo atual.

### `GET /perfil/link-agendamento` — `NOVO`

```json
{ "slug": "thamires-beauty", "url": "https://agendar.thamiresbeauty.com.br/thamires-beauty" }
```

Decisão do dono do projeto: **o link é fixo por salão**, não por cliente/convite — a
profissional compartilha essa mesma URL sempre (bio do Instagram, WhatsApp etc.), sem
expiração e sem precisar gerar um link por pessoa. `slug` é derivado do nome do salão
no cadastro (normalizado, sem acento/espaço) com sufixo numérico em caso de colisão
(`thamires-beauty-2`); não há endpoint de regenerar nesta versão — mudar de slug muda a
URL que ela já divulgou, então fica manual/suporte enquanto não houver pedido pra isso.

---

## 8. `servicos` — 6 operações

Tabela de preços do salão. Módulo próprio para não estourar o `perfil`.

### `GET /servicos` — `NOVO`

```json
{ "servicos": [
  { "id": "uuid", "nome": "Extensão de cílios", "descricao": "Alongamento com efeito natural.", "categoria": "Cílios", "preco": 180.00,
    "duracao_minutos": 90,
    "produtos_padrao": [
      { "item_estoque_id": "uuid", "nome": "Fio mink 0.07",
        "quantidade": 1, "unidade": "un" }
    ] }
] }
```

`duracao_minutos` existe por causa do **agendamento público** (§10): é o que o
servidor soma para calcular quanto tempo um horário escolhido pelo cliente bloqueia na
agenda. Obrigatório e `> 0` — sem duração não dá para calcular horário livre.

`descricao` é opcional, aceita até 500 caracteres e é devolvida no catálogo público
para a cliente entender o serviço antes de selecioná-lo. Ela não participa de nenhum
cálculo financeiro nem do cálculo de duração.

`produtos_padrao` é o vínculo do serviço com o estoque: **todo serviço realizado
consome, por padrão, os itens listados aqui**. É o que a tela de finalizar atendimento
usa para já abrir a baixa preenchida — a usuária confere e ajusta o que saiu a mais ou
a menos, em vez de lembrar do zero. Tabela `servico_produtos_padrao` a criar.

`nome` e `unidade` vêm **resolvidos do item**, não do que o cliente mandou: sem isso a
tela teria que cruzar duas listas só para escrever "2 cx".

### `GET /servicos/categorias` — `NOVO`

```json
{ "categorias": [{ "id": "uuid", "nome": "Cílios" }] }
```

Lista as categorias cadastradas pela profissional, inclusive as que ainda não têm serviço.
É essa lista — e somente ela — que o seletor do formulário de serviço exibe.

### `POST /servicos/categorias` — `NOVO`

```json
{ "nome": "Sobrancelhas" }
```

Cria uma categoria de 1 a 60 caracteres, única por salão sem diferenciar maiúsculas de
minúsculas. Repetição devolve `409 CATEGORIA_JA_EXISTE`.

### `POST /servicos` — `NOVO`
### `PATCH /servicos/{id}` — `NOVO`

Mesmo corpo nos dois. O `PATCH` **substitui** a lista inteira de produtos padrão — o
app manda o estado final da tela, não um diff:

```json
{ "nome": "Extensão de cílios", "descricao": "Alongamento com efeito natural.", "categoria": "Cílios", "preco": 180.00, "duracao_minutos": 90,
  "produtos_padrao": [
    { "item_estoque_id": "uuid", "quantidade": 1 }
  ] }
```

- `produtos_padrao` é opcional; ausente ou `[]` significa serviço que não consome
  material.
- `item_estoque_id` inexistente ou inativo é **404**, e nada é gravado: material
  fantasma vira uma baixa de estoque que nunca fecha.
- `item_estoque_id` repetido no mesmo corpo é **422** — duas linhas do mesmo item viram
  duas baixas que ninguém confere na hora de finalizar.
- `quantidade` > 0.
- `categoria` deve ser uma categoria já cadastrada em `POST /servicos/categorias`; a tela
  oferece um seletor, não texto livre. O link público agrupa os serviços por essa categoria;
  categorias sem serviços não são exibidas.

### `DELETE /servicos/{id}` — `NOVO`

Serviço já usado em atendimento: soft delete. O snapshot no atendimento preserva nome e
preço históricos.

---

## 9. `alertas` — 8 operações

**O cálculo do alerta é do servidor** (S7). O app não varre listas procurando
`quantidade <= minima`: ele busca alertas prontos. Motivo: a mesma regra tem que valer
para o push e para o n8n, que não passam pelo app.

Tipos de alerta na V1:

| `tipo` | Dispara quando | `severidade` |
|---|---|---|
| `estoque_negativo` | `quantidade_atual < 0` (atendimento/montagem confirmados sem saldo) | `critico` |
| `estoque_critico` | `quantidade_atual == 0` | `critico` |
| `estoque_baixo` | `quantidade_atual <= quantidade_minima` | `alerta` |
| `gasto_a_vencer` | pendente vencendo em ≤7 dias | `alerta` |
| `gasto_vencido` | pendente com prazo passado | `critico` |
| `custo_fixo_a_vencer` | custo fixo da competência corrente **em aberto**, vencendo em ≤7 dias | `alerta` |
| `custo_fixo_vencido` | custo fixo da competência corrente **em aberto** com o dia já passado | `critico` |
| `saldo_negativo` | saldo do mês < 0 no fechamento parcial | `critico` |
| `zero_a_zero` | saldo do mês < limite configurado | `alerta` |
| `agendamento_publico_novo` | cliente marcou um atendimento pelo link (§10) | `info` |

### `GET /alertas` — `NOVO`

Query: `apenas_nao_lidos` (bool), `tipo`, `severidade`.

Antes de devolver a central, o servidor sincroniza os alertas ativos de cada item de
estoque. A regra usa `quantidade_atual` para itens por quantidade e
`usos_disponiveis` para rendimento; portanto uma reposição ou conferência resolve a
condição mesmo que a tela de Estoque não tenha sido aberta. Há no máximo um alerta
vivo por item e condição.

```json
{
  "total_nao_lidos": 4,
  "resumo": { "critico": 2, "alerta": 2, "info": 0 },
  "alertas": [
    {
      "id": "uuid",
      "tipo": "estoque_critico",
      "severidade": "critico",
      "titulo": "Cola adesiva para cílios acabou",
      "mensagem": "Você está com 0 un. e o mínimo é 2 un.",
      "referencia_tipo": "estoque_item",
      "referencia_id": "uuid",
      "criado_em": "2026-09-01T08:00:00-03:00",
      "lido_em": null
    }
  ]
}
```

`resumo.critico + resumo.alerta` é o número do **badge** no ícone de Estoque, hoje
calculado no cliente (`EstoqueProvider.totalAlertas`).

`referencia_tipo` + `referencia_id` é o que permite tocar no alerta e cair na tela
certa. O app mapeia tipo → rota; o servidor não conhece rotas de UI.

### `GET /alertas/eventos` — `NOVO`

Abre um canal `text/event-stream` autenticado para avisar que os alertas da usuária
mudaram. O corpo do evento é um sinal curto — a lista completa continua vindo de
`GET /alertas`, que permanece a fonte da verdade:

```text
event: alertas
data: {"tipo":"alteracao"}
```

O canal usa Pub/Sub do Redis/Upstash somente no servidor. O token do Redis nunca é
enviado ao navegador. Ao receber o evento, o app invalida as consultas de alertas e
atualiza badge, banner e central em seguida. Se o Redis não estiver configurado ou
o canal cair, o app mantém a atualização periódica existente como fallback.

### `PATCH /alertas/{id}/lido` — `NOVO`
### `PATCH /alertas/lidos` — `NOVO`

Marca todos como lidos. Corpo opcional `{ "tipo": "estoque_baixo" }` para marcar só um
recorte.

### `GET /alertas/preferencias` — `NOVO`
### `PUT /alertas/preferencias` — `NOVO`

```json
{
  "limite_saldo_alerta": 150.00,
  "dias_antecedencia_vencimento": 7,
  "canais": {
    "in_app":   { "ativo": true },
    "push":     { "ativo": true },
    "whatsapp": { "ativo": false },
    "email":    { "ativo": false }
  },
  "tipos_silenciados": ["zero_a_zero"]
}
```

`dias_antecedencia_vencimento` vale para **gasto pendente e custo fixo** — é uma
janela só, e uma semana é o padrão: é o prazo que ainda dá tempo de fazer alguma
coisa. (Chamava-se `dias_antecedencia_gasto`, com 3 dias; mudou junto com o custo fixo
ganhar dia de vencimento, e nenhum backend consumia o nome antigo.)

Custo fixo tem par "vencido" porque o servidor **sabe** se ela pagou: o `PATCH
/perfil/custos-fixos/{id}/pagar` (§7) grava a competência. Enquanto o mês corrente
estiver em aberto, o vencimento que conta é o **deste mês**, e ele fica para trás —
isso é `custo_fixo_vencido`. Marcada como paga, a competência para de gerar alerta e o
próximo alvo é o mês seguinte. Mês curto encurta o dia: com `dia_vencimento` 31,
fevereiro avisa no dia 28; o 31 continua guardado.

A **competência entra na chave de dedupe** dos dois tipos: o aluguel de setembro e o de
outubro são dois avisos, e marcar um como lido não pode calar o outro.

`referencia_tipo` é `custo_fixo`, e o app leva para o **Perfil** — é lá que ela marca
como pago ou conserta o valor e o dia, não em Gastos.

Os canais `whatsapp` e `email` já aparecem no contrato, desligados — ver §10.

### `POST /dispositivos` — `NOVO`

```json
{ "token": "fcm-token...", "plataforma": "android", "modelo": "Moto G84" }
```

Para `plataforma: "web"`, `token` é o `endpoint` da assinatura e o corpo também
leva as chaves que o navegador devolveu:

```json
{
  "token": "https://push.example/...",
  "plataforma": "web",
  "modelo": "Chrome no Android",
  "assinatura_web_push": {
    "endpoint": "https://push.example/...",
    "keys": { "p256dh": "...", "auth": "..." }
  }
}
```

`plataforma` ∈ `android` · `ios` · `web`. Idempotente por token. Alertas que
aparecem na central — inclusive os inseridos por RPC, como o agendamento pelo
link — são entregues aos endpoints web ativos por Web Push/VAPID. O envio respeita
`canal_push` e `tipos_silenciados` e é marcado em `alertas.push_enviado_em` para
não repetir a mesma notificação.

### `DELETE /dispositivos/{token}` — `NOVO`

Chamado no logout — senão a próxima usuária do aparelho recebe alertas alheios.

---

## 10. `agendamento_publico` — 3 operações

**O único módulo sem `Authorization`.** É a tela que o cliente abre pelo link fixo do
salão (§7) para marcar um horário sozinho, sem login — decisões do dono do projeto:

- Link fixo por salão (não por cliente/convite, não expira).
- Cliente pode escolher **múltiplos serviços** no mesmo agendamento, igual ao fluxo
  interno (§2) — a duração do horário bloqueado é a **soma** de `duracao_minutos` de
  cada serviço escolhido.
- **Confirmação automática**: ao escolher um horário livre, o agendamento já entra como
  `agendado` — não existe estado "pendente de aprovação". Isso só é seguro porque
  `horarios-disponiveis` (abaixo) nunca oferece um horário que já colide com outro
  atendimento.

Autenticação: **nenhuma**. O `slug` na URL identifica o salão — não é secreto (a ideia
é ser compartilhável), então nenhum dado sensível do salão pode vazar aqui além do que
a profissional configura para o cartão de visita público (nome, foto, contatos,
endereço, expediente, serviços e preços).

### `GET /agendamento-publico/{slug}` — `NOVO`

```json
{
  "salao": {
    "nome": "Thamires Borges Beauty", "foto_url": "https://...",
    "telefone_whatsapp": "+5511999999999", "instagram_url": "@thamiresbeauty",
    "endereco": "Rua Exemplo, 123 — São Paulo, SP",
    "descricao_publica": "Especialista em cílios e sobrancelhas.",
    "horarios": [{ "dia_semana": 1, "ativo": true,
                   "hora_inicio": "08:00", "hora_fim": "12:00",
                   "hora_inicio_2": "13:00", "hora_fim_2": "18:00" }]
  },
  "servicos": [
    { "id": "uuid", "nome": "Extensão de cílios", "descricao": "Alongamento com efeito natural.", "categoria": "Cílios",
      "preco": 180.00, "duracao_minutos": 90 }
  ]
}
```

`slug` inexistente ou salão inativo → `404 RECURSO_NAO_ENCONTRADO`. Não devolve
custo fixo, estoque ou qualquer outro dado sensível do módulo `perfil` — os contatos,
endereço e expediente acima são públicos porque a profissional opta por configurá-los
para a cliente na própria tela Perfil.

`descricao` é opcional e acompanha cada serviço no catálogo. Serviços antigos sem
descrição devolvem `descricao: ""`.

### `GET /agendamento-publico/{slug}/horarios-disponiveis` — `NOVO`

Query: `data` (date, obrigatório), `servico_ids` (csv de uuid, obrigatório).

```json
{
  "duracao_total_minutos": 150,
  "horarios": ["09:00", "09:30", "10:00", "13:30", "14:00"]
}
```

Cálculo, todo no servidor: pega os um ou dois turnos do dia da semana de `data` em
`horario_funcionamento` (§7) — dia `ativo: false` devolve `horarios: []` — gera os
slots possíveis a cada 30 min dentro de cada turno (nunca durante a pausa), e remove os que colidem com
qualquer `atendimento` `agendado`/`finalizado` daquele dia (considerando a duração de
cada um) ou que não caibam antes do fim do expediente com a `duracao_total_minutos`
pedida. `data` no passado → `horarios: []` (não é erro, só não há o que oferecer).

### `POST /agendamento-publico/{slug}/agendar` — `NOVO`

```json
{
  "cliente_nome": "Fernanda",
  "cliente_telefone": "+5511988887777",
  "data": "2026-09-10T14:00:00-03:00",
  "servicos": [{ "servico_id": "uuid" }]
}
```

Cria o `atendimento` direto como `agendado` — mesma regra de preço/serviço congelado
do `POST /atendimentos` (§2), com `origem: "publico"` (ver §14). **O servidor
revalida a disponibilidade na hora de gravar** (não confia no que o `GET
horarios-disponiveis` devolveu segundos atrás — dois clientes podem estar olhando o
mesmo horário ao mesmo tempo): se o horário deixou de estar livre,
`409 HORARIO_INDISPONIVEL` e nada é gravado; o app reconsulta os horários e pede pra
escolher outro. Sem segunda passada tipo A5 — não existe "agendar mesmo assim" contra
a própria agenda.

Ao gravar com sucesso, gera o alerta in-app "novo agendamento pelo link" (módulo
`alertas`, tipo a acrescentar em §9) para a profissional ver na próxima abertura do
app — reaproveita o mesmo canal, não precisa do n8n para isso.

---

## 11. Canais futuros (WhatsApp e e-mail) — mapeados, não implementados

Decisão A3: entram no contrato agora, ligam depois. O n8n já tem os fluxos
(`n8n/fluxo_1_alerta_saldo_mensal.json`, `fluxo_2_resumo_semanal.json`).

| Endpoint | Quem chama | Status |
|---|---|---|
| `GET /interno/alertas-pendentes` | n8n (cron) | `NOVO`, futuro |
| `POST /interno/alertas/{id}/entregue` | n8n, após enviar | `NOVO`, futuro |
| `GET /relatorio/semanal` | n8n (cron semanal) | `EXISTE` |
| `POST /webhooks/confirmacao` | n8n | `EXISTE` |
| `POST /webhooks/acionar-resumo-semanal` | n8n | `EXISTE` |

Autenticação dos `/interno/*` e `/webhooks/*`: secret compartilhado em `X-N8N-Secret`,
como já é feito hoje. **Hoje o secret só é exigido em produção**
(`_validar_n8n` em `api/app/routers/webhooks.py`) — endpoints internos que devolvem dado
da usuária devem exigi-lo em todo ambiente.

---

## 12. Códigos de erro (`AppErrorCodes`)

Todo código aqui tem uma chave correspondente no ARB do app. Código novo no backend sem
entrada aqui = mensagem genérica na tela.

| Código | HTTP | Significado |
|---|---|---|
| `AUTH_CREDENCIAIS_INVALIDAS` | 401 | e-mail ou senha incorretos |
| `AUTH_SERVICO_INDISPONIVEL` | 503 | Supabase Auth indisponível ou falha inesperada ao autenticar |
| `AUTH_REFRESH_INVALIDO` | 401 | refresh expirado/revogado → logout |
| `AUTH_TOKEN_AUSENTE` | 401 | requisição sem `Authorization` |
| `VALIDACAO_INVALIDA` | 422 | corpo malformado; `result` traz os campos |
| `RECURSO_NAO_ENCONTRADO` | 404 | id inexistente |
| `ATENDIMENTO_STATUS_INVALIDO` | 409 | operação incompatível com o status atual |
| `ESTOQUE_INSUFICIENTE` | 409 | baixa maior que o saldo; `result.faltantes` lista o que falta. Reenviar com `confirmar_estoque_insuficiente: true` passa por cima (§2 e §6) |
| `KIT_NAO_MONTADO` | 409 | venda maior que `quantidade_montada`; sem confirmação por cima |
| `ITEM_EM_USO` | 409 | exclusão de item/serviço com histórico → use soft delete |
| `CATEGORIA_JA_EXISTE` | 409 | categoria de serviço já cadastrada para o salão |
| `CODIGO_BARRAS_JA_CADASTRADO` | 409 | `codigo_barras` do item já pertence a outro item do mesmo usuário |
| `GASTO_JA_PAGO` | 409 | reservado; hoje `/pagar` é idempotente e devolve 200 |
| `LIMITE_EXCEDIDO` | 429 | rate limit |
| `HORARIO_INDISPONIVEL` | 409 | agendamento público: horário deixou de estar livre entre a consulta e a gravação (§10) |

Faixas sem código de negócio caem no tratamento genérico do `ErrorModel`: 401/403 →
sessão expirada, 404 → não encontrado, 4xx → erro de requisição, 5xx → erro de servidor,
sem resposta → erro de conexão.

---

## 13. Resumo por módulo

| Módulo | Operações | `EXISTE` | `ALTERAR` | `NOVO` |
|---|---|---|---|---|
| `auth` | 4 | — | — | 4 |
| `atendimentos` | 7 | — | — | 7 |
| `gastos` | 5 | — | — | 5 |
| `resumo` | 2 | 1 | 1 | — |
| `estoque` | 6 | — | — | 6 |
| `kits` | 6 | — | — | 6 |
| `perfil` | 10 | — | — | 10 |
| `servicos` | 4 | — | — | 4 |
| `alertas` | 8 | — | — | 8 |
| `agendamento_publico` | 3 | — | — | 3 |
| n8n / interno | 5 | 3 | — | 2 |
| **Total** | **60** | **4** | **1** | **55** |

## 14. Mudanças necessárias no banco

**O SQL pronto está em [`database/migrations/001_v1_completo.sql`](../database/migrations/001_v1_completo.sql)** — idempotente, executável direto no SQL Editor do Supabase. Esta seção é só o resumo do que ele faz. O agendamento público (§10) ainda **não** tem migration escrita — entra numa `002_agendamento_publico.sql` própria (ver `.specs/pedidos-backend.md`, lote L8).

**Tabelas novas (11):** `perfil_salao` · `estoque_itens` · `estoque_movimentacoes` ·
`kits` · `kit_itens` · `kit_vendas` · `servico_produtos_padrao` · `alertas` ·
`alerta_preferencias` · `dispositivos` · `refresh_tokens`.

**Tabelas novas para o agendamento público (a escrever, lote L8):**

| Tabela/coluna | Para quê |
|---|---|
| `servicos.duracao_minutos` | calcular quanto tempo um agendamento bloqueia na agenda (§8) |
| `horario_funcionamento` (`salao_id`, `dia_semana`, `ativo`, `hora_inicio`, `hora_fim`, `hora_inicio_2`, `hora_fim_2`) | expediente por dia da semana, com pausa opcional (§7) |
| `salao.slug_agendamento` | URL fixa do link público (§7), único, gerado no cadastro |
| `atendimentos.origem` (`interno` \| `publico`) | diferenciar na lista/alerta quem veio pelo link (§10) |

**Alterações:**

| Tabela | Mudança | Por quê |
|---|---|---|
| `gastos` | `descricao` → `nome` | alinha com o app e com o protótipo |
| `gastos` | `forma_pagamento` passa a `a_vista`/`credito`/`debito`/`pix` | o check atual só aceita `à vista`/`cartão`, com acento e espaço |
| `gastos` | `prioridade` → `categoria` (`fixo`/`material`/`outros`) | o protótipo agrupa por categoria, não por prioridade |
| `gastos` | `+ pago_em timestamptz` | saber *quando* pagou, não só que pagou |
| `atendimentos` | `+ status` (`agendado`/`finalizado`/`cancelado`) | o app já usa; o banco não tem |
| `atendimentos` | `+ finalizado_em`, `+ cancelado_em` | auditoria do que entra no resumo |
| `atendimento_insumos` | `+ item_estoque_id` (fk nulável), `+ quantidade` | ligar o insumo ao estoque; nulável porque insumo avulso continua válido |
| `servicos` | `+ ativo boolean` | soft delete: serviço com histórico não some |

**Sem migração de dados destrutiva.** `forma_pagamento` e `categoria` são convertidos por
`update` a partir dos valores antigos (`'à vista'` → `a_vista`, `'cartão'` → `credito`,
prioridade `alta` → categoria `fixo`), então o que já existe no banco sobrevive.

**RLS** continua ligada como segunda barreira, mas o FastAPI passa a acessar com a
service role e **filtra por usuário derivado do token** — o que só é seguro depois de
corrigir a validação do JWT (§0).
