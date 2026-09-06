import { ApiError } from "../error-codes";
import { supabase } from "../supabase";
import type { AgendamentoCriado, AgendamentoPublicoPagina, HorariosDisponiveis } from "../types";

/**
 * `agendamento_publico` — sem FastAPI no meio (branch `feat/react-supabase`).
 *
 * Único módulo sem sessão: o `slug` na URL identifica o salão (link fixo,
 * decisão B1). Confirmação é automática — não existe "pendente" aqui (B4).
 *
 * Também é o único módulo que não fala com as tabelas direto: um cliente
 * anônimo esbarra na RLS de todo o resto do banco
 * (`using (auth.uid() = user_id)`), e a disponibilidade de horário precisa
 * ser recalculada no mesmo instante em que grava — duas requisições
 * concorrentes de dois clientes públicos não podem achar o mesmo horário
 * livre e reservar as duas, e um `select` seguido de `insert` no navegador
 * não garante isso. As 3 operações passam por RPCs `security definer`
 * (`database/migrations/004_agendamento_publico_rpc.sql`), que fazem
 * exatamente o que o service role do FastAPI fazia antes da A1 cair: olhar
 * através da RLS só o suficiente (nome do salão, tabela de preços,
 * expediente), nunca telefone/estoque/custo fixo — e, no `agendar`, travar
 * (`pg_advisory_xact_lock`) e revalidar antes de gravar.
 */

export interface AgendarBody {
  cliente_nome: string;
  cliente_telefone: string;
  /** ISO-8601 com horário e fuso. */
  data: string;
  servicos: { servico_id: string }[];
}

function erroSupabase(error: { message: string }): ApiError {
  const mensagem = error.message ?? "";
  if (mensagem.includes("SALAO_NAO_ENCONTRADO")) {
    return new ApiError(404, "RECURSO_NAO_ENCONTRADO", "Esse link de agendamento não existe ou não está mais ativo.");
  }
  if (mensagem.includes("SERVICO_INVALIDO") || mensagem.includes("VALIDACAO_INVALIDA")) {
    return new ApiError(422, "VALIDACAO_INVALIDA", "Confira os serviços e dados informados.");
  }
  if (mensagem.includes("HORARIO_INDISPONIVEL")) {
    return new ApiError(409, "HORARIO_INDISPONIVEL", "Esse horário acabou de ser preenchido. Escolha outro.");
  }
  return new ApiError(500, null, mensagem);
}

export const AgendamentoPublicoApi = {
  async obterPagina(slug: string): Promise<AgendamentoPublicoPagina> {
    const { data, error } = await supabase.rpc("agendamento_publico_pagina", { p_slug: slug });
    if (error) throw erroSupabase(error);
    return data as unknown as AgendamentoPublicoPagina;
  },

  async obterHorariosDisponiveis(
    slug: string,
    data: string,
    servicoIds: string[],
  ): Promise<HorariosDisponiveis> {
    const { data: resultado, error } = await supabase.rpc("agendamento_publico_horarios", {
      p_slug: slug,
      p_data: data,
      p_servico_ids: servicoIds,
    });
    if (error) throw erroSupabase(error);
    return resultado as unknown as HorariosDisponiveis;
  },

  async agendar(slug: string, body: AgendarBody): Promise<AgendamentoCriado> {
    const { data, error } = await supabase.rpc("agendamento_publico_agendar", {
      p_slug: slug,
      p_cliente_nome: body.cliente_nome,
      p_cliente_telefone: body.cliente_telefone,
      p_data: body.data,
      p_servico_ids: body.servicos.map((s) => s.servico_id),
    });
    if (error) throw erroSupabase(error);
    return data as unknown as AgendamentoCriado;
  },
} as const;
