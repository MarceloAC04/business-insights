# Regressão da conferência de estoque

O teste usa PostgreSQL em memória (PGlite) e um esquema mínimo compatível com as
tabelas envolvidas. Não lê `.env`, não usa credenciais e não acessa o Supabase.

Na raiz do repositório, com Node instalado:

```powershell
npm install --prefix database/tests --no-save --no-package-lock @electric-sql/pglite@0.5.8
node --test database/tests/conferencia_estoque.test.mjs database/tests/rendimento_por_usos.test.mjs database/tests/encerrar_controles_legados.test.mjs database/tests/fluxos_estoque_atomicos.test.mjs
```

Verifica saldo absoluto (inclusive zero), histórico, preservação de custo,
isolamento por usuário, permissões do RPC, reexecução da migração e rollback
quando a gravação do histórico falha. Também verifica a migração de rendimento:
6 embalagens que rendem 10 usos viram 60 usos, uma composição de serviço de
0,1 embalagem vira 1 uso. A etapa seguinte confirma que os itens que não podem
ter rendimento deduzido (ml/g/caixa ou componentes de kit) preservam o saldo
físico e passam a `quantidade`, sem alerta de validade ativo. O ambiente em memória não simula a concorrência de conexões
independentes do Supabase.

Testes complementares:

```powershell
cd api
.\venv\Scripts\python.exe -m pytest tests/test_estoque.py tests/test_atendimentos_service.py tests/test_servicos.py -q -p no:cacheprovider
cd ../frontend/salao_web
node --test tests/estoque.test.mjs
```

## Ativação no ambiente publicado

Aplicar `database/migrations/011_conferencia_estoque.sql`,
`database/migrations/012_rendimento_por_usos.sql` e
`database/migrations/013_encerrar_controles_legados.sql` e
`database/migrations/014_fluxos_estoque_atomicos.sql` antes de publicar o backend e,
depois, o frontend. As migrações preservam dados, adicionam os campos de histórico
e habilitam o RPC usado pelo FastAPI. A 012 converte os rendimentos inequívocos; a
013 deixa os demais itens em saldo físico, elimina a abertura de pote e resolve os
alertas legados de validade. A 014 torna finalização, estorno, montagem e venda de kit
operações atômicas. Não reexecutar a migração 008.

Em um rollback da aplicação, manter essa estrutura aditiva: o histórico novo
pode conter contagens zero. Restaurar a restrição antiga exigiria remover dados
válidos, e não deve ser feito. Não usar a versão antiga para realizar contagens,
pois ela contém o erro corrigido nesta etapa.
