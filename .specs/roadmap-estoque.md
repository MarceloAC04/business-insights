# Estoque — proposta de fluxo e roadmap de melhoria

Data: 07/09/2026. Status: **etapas 1, 2 e 3 implementadas localmente; ativação da etapa 3 pendente da migração 013. Etapas 4 a 6 propostas**.

### Entrega da etapa 1 — 07/09/2026

- Conferência define o saldo absoluto e aceita zero, com histórico de saldo
  anterior → atual e preservação do custo.
- Compra, saída e conferência têm ações separadas, rótulos visíveis e prévia
  do saldo. Saída manual sem saldo é rejeitada também no demo.
- Contrato atualizado; migração `011_conferencia_estoque.sql` grava conferência
  e histórico na mesma transação. Aplicação no banco publicado ainda pendente.
- Verificações: testes focados da API, demo e PostgreSQL em memória; typecheck
  e build. O lint configurado ainda aponta normalização CRLF e problemas
  anteriores em arquivos React, inclusive `BarcodeScanner.tsx`, fora desta etapa.
- Fluxo conferido no navegador local em 390 × 844 e 1366 × 900: contagem para
  zero, compra, saída e histórico. Instruções de teste/publicação em
  `database/tests/README.md`.

### Entrega da etapa 2 — 07/09/2026

- O modo `rendimento_usos` separa embalagem e capacidade: 6 potes que rendem
  10 usos mostram 60 usos, com custo de R$ 5 por uso para um pote de R$ 50.
- A baixa de um atendimento recebe usos, desconta a fração física equivalente
  e grava no histórico tanto a embalagem quanto a quantidade lógica consumida.
- O cadastro de produto passou a começar a contagem no próprio saldo e não
  oferece mais “abrir pote”. Compra, saída e conferência continuam operando
  em embalagens para não misturar medidas.
- Alertas de rendimento usam o limite configurado em usos. Itens legados em
  ml/g/caixa ou ligados a kits não são convertidos sem conferência explícita.
- Verificações: 42 testes focados da API, 16 do demo, 3 de migração PGlite,
  typecheck e build. O lint permanece com a pendência global de normalização
  CRLF e problemas anteriores fora desta etapa.

### Entrega da etapa 3 — 07/09/2026

- `013_encerrar_controles_legados.sql` transforma os itens residuais de
  `validade_*` em saldo físico, sem adivinhar rendimento para ml/g/caixa ou
  componentes de kit; limpa os contadores antigos e resolve seus alertas vivos.
- A API aceita apenas `quantidade` e `rendimento_usos`, rejeita campos legados
  e não oferece rota de abrir pote. Finalização de atendimento e montagem de
  kit deixam de manter contador paralelo.
- O React e o demo mostram somente saldo físico ou capacidade por usos; o
  resumo não apresenta produto como vencido.
- Verificações: 12 cenários PGlite nas migrações 011–013, 53 testes focados
  da API, 16 testes do demo, typecheck e build. A migração 013 não foi
  executada no banco publicado por esta tarefa.

O diagnóstico abaixo descreve o estado anterior às três entregas locais.
As etapas 4 a 6 continuam propostas.

Base: leitura do frontend React, FastAPI, modo demo, contrato e migrações locais.
As etapas 1 e 2 também foram validadas contra uma conta isolada no banco
publicado; a etapa 3 ainda depende de aplicar a migração 013 antes dessa
validação. Os problemas abaixo registram o código anterior às entregas locais.

## 1. O resultado esperado

A usuária deve conseguir responder sem fazer conversões:

- Quanto produto tenho e quanto isso ainda rende?
- O que vai acabar primeiro e quando preciso comprar?
- O que foi consumido em cada serviço e quanto custou?
- Como registrar uma compra, uma perda ou uma correção?

Manter o vínculo produto → serviço e a baixa ao finalizar o atendimento. Manter
alertas de estoque baixo. Retirar a operação de abrir pote do fluxo.

**Esclarecimento confirmado pela usuária:** “dura X dias” significa que costuma
acabar após esse tempo de uso, e não que precisa ser descartado após esse prazo.
Portanto, os termos corretos são **rendimento** e **duração estimada**. Validade
real, se vier a ser necessária, é outra informação.

## 2. Diagnóstico do fluxo atual

| Problema observado | Evidência local | Consequência |
|---|---|---|
| O contador considera uma unidade, sem calcular a capacidade de todo o estoque | `api/app/services/estoque_service.py:51` | Se cada creme rende 10 usos, o contador parte de 10 mesmo com 6 cremes cadastrados. |
| Saldo físico e contador de atendimentos seguem regras independentes | `api/app/services/atendimentos_service.py:348` e `:399` | A quantidade informada é descontada do saldo e, separadamente, soma-se um atendimento. Quantidade dobrada não dobra esse contador. |
| O formulário permite ml, g ou caixa junto com controle por dias/atendimentos | `frontend/salao_web/src/routes/estoque.tsx:126`; `api/app/schemas/estoque.py:5` | A usuária precisa descobrir se o número representa embalagem, volume ou uso. |
| Cadastrar já inicia a contagem, mas a tela continua exigindo o conceito de abertura | `api/app/services/estoque_service.py:227`; `frontend/salao_web/src/routes/estoque.tsx:617` | Há dois gatilhos para o mesmo contador e linguagem contraditória. |
| Toda compra reinicia a contagem anterior | `api/app/services/estoque_service.py:389` | Repor produto faz desaparecer o progresso de consumo, mesmo que ainda exista produto anterior. |
| Saída manual soma um atendimento independentemente do motivo e da quantidade | `api/app/services/estoque_service.py:394` | Perder um frasco pode ser contado como um único atendimento. |
| Ajuste tem significados diferentes no app e no servidor | `frontend/salao_web/src/routes/estoque.tsx:849`; `api/app/services/estoque_service.py:344` | A tela promete definir o saldo contado; o servidor soma o valor. Saldo 6, contagem 4: deveria terminar em 4, mas resulta em 10. |
| Não é possível corrigir a contagem para zero | `frontend/salao_web/src/routes/estoque.tsx:329`; `api/app/schemas/estoque.py:95` | A operação mais comum quando algo acaba é rejeitada. |
| Consumo estimado é apresentado como vencimento | `frontend/salao_web/src/routes/estoque.tsx:584`; `api/app/services/estoque_service.py:125` | “Validade vencida” transmite uma informação que o sistema não conhece. |
| Ações principais aparecem apenas como ícones | `frontend/salao_web/src/routes/estoque.tsx:617` | É difícil distinguir compra, saída e reinício da contagem, sobretudo no celular. |
| O cadastro sugere 15 atendimentos ou 45 dias por palavras no nome | `frontend/salao_web/src/routes/estoque.tsx:187` | Uma sugestão sem base no produto pode virar um número tratado como confiável. |
| O alerta temporal é atualizado ao listar estoque | `api/app/services/estoque_service.py:125` e função `listar` | Nesse caminho, o tempo só se reflete na central após consultar os itens. O alerta deve ser atualizado independentemente de visitar a tela. |

Há ainda dependências que precisam entrar na entrega:

- Cancelar um atendimento finalizado devolve a quantidade, mas não desfaz o
  contador separado de usos (`api/app/services/atendimentos_service.py:491`).
- O demo define o saldo na operação de ajuste; o FastAPI soma. Uma demonstração
  pode parecer correta enquanto o comportamento real é diferente
  (`frontend/salao_web/src/lib/demo/demo-database.ts`, `createMovimentacao`).
- O catálogo contém unidades que precisam ser conferidas. Exemplo: Microbrush
  está em caixas na migração 008, enquanto o serviço consome quantidade 3 na 009.
  É preciso confirmar quantas peças há por caixa, sem assumir que são três caixas.
- Há rendimentos e consumos que não se correspondem: cola rende 15 atendimentos
  no catálogo, mas o serviço usa 0,1 frasco; henna rende 10, mas usa 0,15 pote
  (`database/migrations/009_ajuste_validade_produtos_padrao.sql`). Podem existir
  usos diferentes por serviço, mas hoje essa diferença não fica explícita.

## 3. Modelo recomendado

### 3.1 Unidade de compra e rendimento precisam ter nomes distintos

Para produtos controlados por rendimento ou dias, a unidade física será sempre
**unidade**. “Pote”, “frasco” e “tubo” podem ser nomes amigáveis dessa embalagem.
Não mostrar um seletor de ml/g/caixa nesses cadastros.

| Informação | Exemplo |
|---|---|
| Produto | Creme facial |
| Quantas unidades tenho? | 6 potes |
| Quanto rende cada unidade? | 10 usos |
| Quanto paguei por unidade? | R$ 50,00 |
| Avisar quando restarem | 10 usos |
| Resultado do cadastro | **Rende cerca de 60 usos · custo estimado de R$ 5,00 por uso** |

“Uso” é a porção padrão consumida por um serviço. A tela pode dizer “60
atendimentos” quando explicar que está considerando um uso por atendimento.
Se dois serviços usam quantidades diferentes, “60 usos padrão” é mais preciso.

Exemplos de apresentação do mesmo produto:

| Momento | O que mostrar |
|---|---|
| Cadastro de 6 potes × 10 usos | Cerca de 60 usos disponíveis |
| Finalizar um serviço que usa 1 porção | Cerca de 59 usos disponíveis |
| Finalizar outro que usa 2 porções | Cerca de 57 usos disponíveis |
| Comprar mais 2 potes | 57 + 20 = cerca de 77 usos disponíveis |
| Descartar um pote cheio | 77 − 10 = cerca de 67 usos disponíveis |

Por trás da tela pode existir o equivalente fracionário de uma unidade, mas a
usuária não deveria precisar informar “0,1 pote”. O servidor realiza a conversão.
Não manter dois saldos editáveis independentes que possam divergir.

O rendimento informado é uma estimativa. “59 usos” não prova quantos frascos
estão fechados ou abertos. Não exibir “5 fechados e 1 aberto” sem dados que
sustentem essa afirmação. Uma conferência física pode recalibrar o saldo.

### 3.2 Três formas de acompanhar, com campos específicos

| Escolha no cadastro | O que a usuária informa | Como acompanha |
|---|---|---|
| Consumo por unidade | Quantidade e unidades consumidas por serviço | Ex.: 100 pads; cada serviço usa 2; restam 98 após finalizar. |
| Rendimento por usos | Unidades e usos por unidade | Ex.: 6 cremes × 10 usos; o serviço baixa usos e o servidor converte. |
| Duração estimada | Unidades e dias que cada unidade costuma durar | Mostra uma previsão de reposição desde o cadastro; não afirma vencimento nem consumo físico comprovado. |

Controle por ml/g continua disponível como opção avançada para quem realmente
mede o consumo. Cadastros existentes não podem ser convertidos de ml/g para
unidades sem conhecer o conteúdo de cada embalagem. Caixas de descartáveis
precisam de uma conversão explícita para peças.

Equipamentos reutilizáveis, como pinças e ventiladores, não entram na baixa
automática de materiais de um serviço. Sua perda ou substituição é uma operação
própria, sem consumir uma peça por atendimento.

### 3.3 Dias são previsão de reposição

Recomendação inicial para uma regra simples: **dias corridos**, contados desde o
cadastro com saldo positivo. O formulário deve dizer isso. É uma proposta, pois
a usuária confirmou o significado de duração, mas não definiu calendário.
“Dias em que o salão funciona” exigiria outra base de contagem; não usar os dois
significados sob o mesmo rótulo.

Exemplo: 6 unidades, cada uma costuma durar 10 dias, usadas em sequência no
ritmo informado → cobertura inicial estimada de 60 dias. Oito dias depois:
estimativa de 52 dias. Compra de 2 unidades nesse momento: acrescenta 20 dias,
ficando em aproximadamente 72, sem reiniciar os oito dias já transcorridos.

Regras para essa previsão:

- Início automático no cadastro com saldo; cadastro zerado começa na primeira
  entrada. A referência da contagem fica visível e pode ser corrigida.
- Não existe botão “abrir pote”.
- Chegar a zero gera “Produto pode ter acabado — confira o estoque”.
- O tempo, sozinho, não registra saída física, descarte ou custo de atendimento.
- No detalhe, distinguir “última contagem informada” da duração estimada. Não
  apresentar a contagem antiga como se tivesse sido conferida hoje.
- Conferir quantas unidades restam recalibra a previsão a partir dessa data.
  Não descontar novamente um consumo que já estava previsto.
- Compras acrescentam capacidade ao restante estimado; previsões esgotadas
  não criam uma dívida de dias que consuma automaticamente a compra nova.
- Perdas reais reduzem a capacidade correspondente. Registrar que uma unidade
  prevista acabou deve levar à conferência do restante, sem duplicar desconto.
- Mudanças de ritmo explicam diferenças entre previsão e realidade. Não
  transformar “dura 10 dias” em uma garantia de disponibilidade.

Se um produto já tem baixa por usos ou quantidade em cada serviço, essa é a
fonte do saldo. Uma previsão em dias pode complementar o alerta, mas não criar
uma segunda baixa. Cada consumo deve ser descontado uma única vez.

### 3.4 Serviço continua sendo o principal gatilho de consumo

No cadastro do serviço: “Produtos usados neste serviço”, com linhas como
“Creme facial: 1 uso” e “Pad: 2 unidades”. Serviços que gastam mais podem usar
2 usos; porções fracionadas, como meio uso, devem ter rótulo claro.

Ao finalizar:

1. Trazer os materiais padrão dos serviços escolhidos, agrupados por produto.
2. Permitir confirmar ou corrigir o consumo daquela execução, inclusive retirar
   um material que não foi usado.
3. Mostrar a prévia: “Será descontado 1 uso de creme e 2 pads”.
4. Registrar atendimento, consumo, custo e movimentações de forma consistente.
5. Atualizar estoque, custo exibido, histórico e alertas.

Agendar não dá baixa. Serviço não relacionado ao produto não reduz seu saldo.
Dois serviços no mesmo atendimento somam suas porções, em vez de contar apenas
“um atendimento”. A baixa depende do uso confirmado, não só do nome do serviço.

Manter A5: se faltar estoque, a primeira tentativa não grava nada e a segunda,
explicitamente confirmada, pode deixar saldo negativo com alerta. Mostrar a
falta na mesma unidade que a usuária está usando: usos ou peças.

### 3.5 Custos precisam acompanhar a mesma conversão

Com um pote de R$ 50 que rende 10 usos, o custo estimado é R$ 5 por uso. Dois
usos custam R$ 10. O custo da embalagem não pode ser cobrado integralmente em
cada atendimento.

Manter a média ponderada móvel de A6, com quantidade e preço expressos na mesma
base. Se mudar o rendimento ou tamanho da embalagem, definir uma conversão
explícita antes de misturar custos. Congelar quantidade, conversão e custo no
atendimento; alterar rendimento hoje não reescreve os resultados passados.

Somente “dura 10 dias” não informa quanto custa um atendimento. Para esse custo,
é necessário informar usos por embalagem ou uma quantidade medida por serviço.
Enquanto faltar esse dado, sinalizar custo incompleto; não assumir custo zero
nem inventar uma divisão pelo número de clientes.

A implementação atual guarda tanto materiais efetivos quanto custo padrão por
serviço. Explicitar “estimado” e “realizado” onde esses números diferirem, sem
trocar silenciosamente o contrato dos relatórios.

## 4. Ações e telas propostas

### Lista de produtos

Exemplo de cartão após o primeiro uso:

> **Creme facial**
>
> **Rende cerca de 59 usos**
>
> Cada pote rende 10 usos · custo estimado de R$ 5,00 por uso
>
> Avisar quando restarem 10 usos
>
> **Adicionar compra** · **Registrar saída** · **Mais opções**

“Mais opções” contém **Conferir quantidade**, **Editar produto** e **Ver
histórico**. Conferir quantidade também deve aparecer diretamente no detalhe.
Botões com texto visível no celular; ícones podem complementar o texto.

| Ação | Pergunta principal | Prévia antes de salvar | Botão de confirmação |
|---|---|---|---|
| Adicionar compra | Quantas unidades chegaram e quanto custaram? | 59 usos + 20 = 79 usos | Adicionar 2 unidades |
| Registrar saída | O que aconteceu: consumo avulso, perda, descarte ou devolução? | 59 usos − 10 = 49 usos, ao retirar um pote cheio | Registrar perda de 1 unidade |
| Conferir quantidade | Quanto realmente resta? | Sistema: 59 usos; conferido: 40; correção: −19 | Atualizar para 40 usos |

Nas saídas, permitir escolher entre unidade inteira e usos para produtos com
rendimento. Não pedir números negativos. Uma saída parcial deve poder ser
registrada sem declarar perda de uma embalagem inteira.

Na contagem, permitir zero. Para rendimento, aceitar unidades completas mais
uma estimativa dos usos restantes da unidade parcial, sem exigir controle de
abertura. “4 potes completos e 3 usos restantes” equivale a 43 usos no exemplo.

Cada ação deve ter histórico com motivo, data, origem, saldo anterior e novo
saldo. Cadastro com quantidade inicial também gera um registro identificável.
Correções posteriores registram o que mudou sem apagar a movimentação original.

“Adicionar compra” movimenta estoque. Uma integração com Gastos pode oferecer
“Lançar também em Gastos” ou vincular um gasto existente, mas deve evitar
duplicidade e distinguir data da compra de pagamento. Não transformar toda
correção de quantidade em despesa.

### Alertas

Usar um limite principal na unidade natural de cada produto:

- Por unidade: “Restam 4 pads. Seu aviso está configurado em 10”.
- Por rendimento: “Creme rende mais 8 usos. Seu aviso está configurado em 10”.
- Por dias: “Reposição prevista em cerca de 3 dias”.
- Previsão esgotada: “Confira o estoque: este produto pode ter acabado”.
- Saldo negativo confirmado: “Há 2 usos registrados sem saldo. Confira ou reponha”.

Os limites serão configuráveis por produto. O painel pode dizer **Precisam de
atenção**, pois conferir uma previsão esgotada não é necessariamente comprar.
Oferecer acesso direto ao produto e à ação apropriada. Reposição/contagem
resolve o alerta quando a condição deixar de existir; marcar como lido apenas
retira a indicação de não lido. Evitar alertas duplicados para a mesma condição.

## 5. Roadmap em ordem de entrega

As etapas abaixo são dependências e critérios de conclusão, sem promessa de
prazo antes de fechar o modelo e examinar os dados existentes.

| Etapa | Entrega | Critério de aceite |
|---|---|---|
| **1 — Corrigir operações atuais (P0) — concluída localmente** | Corrigir contagem absoluta, permitir zero e dar nomes explícitos às ações. Documentar a semântica de ajuste no contrato antes do código. Alinhar demo e FastAPI. | Saldo 6, contagem 4 termina em 4; contagem 0 termina em 0. Compra de 2 termina em 8. Nenhuma operação muda o sentido entre demo e API. |
| **2 — Unificar unidades e rendimento (P0) — concluída localmente** | Definir unidade física, conversão por uso, limites e custos. Migrar por produto com conferência de dados. Trocar o contador de uma unidade pela capacidade total. Integrar consumo de serviços. | 6 × 10 = 60; consumo de 1 deixa 59; consumo de 2 deixa 57; compra de 2 deixa 77. Custo de 1 uso de um pote de R$ 50/10 é R$ 5. |
| **3 — Encerrar os controles legados de duração (P1) — concluída localmente** | A migração 013 transforma os itens restantes de `validade_*` em saldo físico, resolve alertas legados e mantém itens de rendimento já convertidos. API e React aceitam somente saldo ou rendimento por usos; a operação de abrir pote foi removida. | Itens legados preservam saldo, custo e composição; nenhum fluxo ativo pede abertura, descarta produto ou diz “venceu”. |
| **4 — Fechar o ciclo operacional (P1) — concluída localmente** | A migração 014 concentra em transações a finalização, o estorno, a montagem e a venda de kits. A tela tem detalhe por produto, histórico filtrado e contagem de embalagens completas mais usos parciais. | Repetição de uma finalização não duplica baixa; falha não deixa parte dos materiais consumidos; estorno corrige saldo/custo/alertas de forma coerente. |
| **5 — Alertas e validação de ponta a ponta (P1) — concluída localmente** | Limites por produto, central e resumo consistentes, atualização temporal sem depender de abrir estoque, mesma regra no demo. Validar no celular e desktop. | Alertas aparecem na unidade correta, são resolvidos após reposição/conferência e não se duplicam. O fluxo completo pode ser realizado sem explicar conversões. |
| **6 — Melhorias com dados reais (P2) — concluída localmente** | Sugestão de reposição pelo histórico e pela agenda, com lista de compras explicada. A integração com Gastos continua manual: a sugestão não cria gasto, evitando duplicidade. | Estimativas mostram a base usada; a sugestão não sobrescreve configuração nem lança gasto sem decisão da usuária. |

A confiabilidade das gravações faz parte de toda etapa que altera saldo; a
etapa 4 consolida a cobertura dos caminhos adicionais, não autoriza entregar
as etapas anteriores com baixa parcial ou duplicada.

### Regras de kits e cancelamento a preservar

Montar kit continua consumindo insumos; vender baixa somente o kit montado
(A7). Uma embalagem inteira destinada à revenda consome a embalagem e sua
capacidade equivalente — não um único uso do produto. Estoque em usos não
prova disponibilidade de embalagens intactas; se o mesmo item serve ao salão
e à revenda, separar a reserva destinada à revenda ou conferir embalagens
intactas na montagem. Não inferir isso pelo total de usos.

Cancelar um agendamento não movimenta produto. Corrigir uma finalização
registrada por engano precisa desfazer o consumo exatamente uma vez. O
comportamento atual de cancelamento de finalizado com estorno deve permanecer
consistente até uma decisão explícita sobre cancelamento financeiro de um
serviço realmente executado: cancelar a cobrança não faz o material usado
voltar fisicamente ao estoque.

## 6. Cuidados concretos de implementação e migração

- Atualizar `.specs/endpoints-backend.md` antes de implementar mudanças de
  campos/operações. Este roadmap não cria endpoints novos implicitamente.
- Regras e conversões ficam no FastAPI; React recebe saldo, status e custos
  calculados. Preservar A1, A5, A6 e A7. Flutter permanece congelado.
- Migrar de forma incremental: a etapa 013 transforma controles legados em
  saldo físico sem inferir conversão numérica de ml/g/caixa ou composição de kit.
- Conferir embalagem, conteúdo, rendimento, saldo, custo e produtos padrão dos
  serviços. Converter tudo na mesma base e preservar identificadores/vínculos.
- Não usar os contadores legados de abertura para reconstruir consumo passado:
  eles podiam ser reiniciados. Nos casos ambíguos, manter saldo físico até uma
  conferência, preservando o histórico anterior.
- Não converter 1.000 g em 1.000 unidades. Sem peso/volume por embalagem, marcar
  o produto para conferência e manter os dados antigos disponíveis.
- Não reexecutar a migração 008 como forma de migração: ela contém limpeza
  destrutiva de catálogo e vendas. Criar migração própria, preservando dados,
  com comparação antes/depois e caminho de reversão.
- Histórico de atendimentos mantém custo e conversão originais. Mudanças de
  rendimento valem para a regra acordada do saldo atual/futuro, sem reprecificar
  serviços concluídos.
- Executar saldo, custo, histórico e status com proteção contra concorrência.
  A migração 014 faz isso para finalização, estorno e kits; mantê-la antes do
  backend que chama as RPCs correspondentes.
- Alertas temporais precisam de atualização no servidor, por rotina periódica
  ou avaliação consistente na leitura da central, além da lista de estoque.

## 7. Cenários mínimos de aceite

| Cenário | Resultado obrigatório |
|---|---|
| 6 potes com 10 usos por pote | Capacidade de 60 usos, sem abertura manual. |
| Um atendimento usa 1 porção | Restam 59 usos; custo proporcional registrado. |
| Mesmo atendimento contém dois serviços que usam o produto | Descontar a soma das porções, uma única vez. |
| Não usou o produto naquele atendimento | Nenhuma baixa nesse produto. |
| Compra com estoque parcialmente consumido | Acrescentar capacidade e calcular média ponderada; não apagar consumo anterior. |
| Dois envios simultâneos da mesma finalização | Uma finalização e uma baixa efetiva. |
| Falha ao consumir o segundo material | Nenhuma baixa parcial persistente. |
| Saldo 6, contagem física 4 ou 0 | Saldo final exatamente 4 ou 0 e histórico da diferença. |
| Perda de um pote cheio que rende 10 usos | Retirar 1 pote equivalente a 10 usos, sem contar um atendimento. |
| Previsão de duração chega ao fim | Aviso de conferência; nenhum vencimento ou descarte inventado. |
| Reposição após previsão esgotada | A compra nova acrescenta sua capacidade integral. |
| Saldo insuficiente ao finalizar | Primeira tentativa não grava; confirmação pode gerar negativo e alerta. |
| Correção de finalização indevida | Estorno único, sem reaplicar compra ou recalcular custo histórico. |
| Montagem e venda de kit | Insumo descontado na montagem; venda não o desconta novamente. |
| Entrada muda custo médio | Estoque, serviços e kits mostram estimativas atualizadas; passado permanece congelado. |
| Conferência ou reposição elimina condição de alerta | Central e produto concordam, inclusive sem visitar antes a lista de estoque. |
| Uso no celular | Todas as ações têm texto visível, unidade explícita e prévia do saldo resultante. |

## 8. O que está confirmado e o que é recomendação

**Confirmado pela usuária:** manter materiais por serviço e alertas; representar
produtos por dias/usos em unidades; 6 unidades × 10 atendimentos = capacidade
para 60; começar a contar no cadastro; retirar a operação de abrir pote;
melhorar ações de entrada/saída; dias significam duração por consumo.

**Recomendado neste documento, ainda sujeito à avaliação:** usar “uso padrão”
como conversão; tratar tempo como previsão sem baixa física automática;
começar com dias corridos explicitamente rotulados; oferecer contagem parcial
e alertas configuráveis; seguir a sequência de entregas acima.

Próxima entrega sugerida: fechar esses critérios e detalhar a etapa 1 no contrato,
seguida de um protótipo do cadastro, cartão e três ações. O exemplo dos 6 cremes
deve ser o caso principal de validação em todas as etapas.
