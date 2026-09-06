import { ApiError } from "../error-codes";
import { supabase } from "../supabase";
import type { CustosFixosPagina, HorarioDia, HorarioFuncionamento, LinkAgendamento, Perfil } from "../types";

/**
 * `perfil` — sem FastAPI no meio (branch `feat/react-supabase`).
 *
 * Fonte mista, diferente de qualquer módulo anterior:
 * - `horario-funcionamento` e `link-agendamento` **tinham** backend real
 *   (`api/app/routers/perfil.py`) — este arquivo espelha exatamente o que
 *   lá estava (mesmas tabelas, mesmo upsert `on_conflict=user_id,dia_semana`,
 *   mesma regra de validação vinda de `app/schemas/perfil.py`).
 * - `GET/PUT /perfil` e todo `custos-fixos` **nunca tiveram** backend — o
 *   próprio router dizia isso no docstring. Fonte de verdade é
 *   `.specs/endpoints-backend.md` §7.
 *
 * `perfil_salao` guarda os nomes de coluna do banco (`nome_salao`,
 * `nome_proprietaria`, `telefone`), diferentes dos nomes que a tela usa
 * (`nome`, `proprietaria`, `telefone_whatsapp`) — mesmo tipo de divergência
 * já visto em `gastos` (forma_pagamento/categoria); o mapeamento vive só
 * aqui, a tela nunca vê o nome de coluna do banco.
 *
 * O custo fixo é **cadastro recorrente**, não lançamento (A5/A6 não se
 * aplicam aqui, isso é perfil de negócio, não estoque): o aluguel existe
 * uma vez e se comporta como pendente ou pago conforme a competência
 * consultada, resolvido a partir de `custos_fixos_pagamentos`
 * (`unique (custo_fixo_id, competencia)` garante que marcar pago duas vezes
 * não duplica nada).
 */

export interface PerfilBody {
  nome: string;
  proprietaria: string;
  telefone_whatsapp?: string | null;
  meta_faturamento_mensal?: number;
}

export interface CustoFixoBody {
  descricao: string;
  valor: number;
  /** Dia literal 1–31. "Todo dia 31" continua 31 em fevereiro. */
  dia_vencimento: number;
}

interface PerfilSalaoRow {
  id: string;
  nome_salao: string;
  nome_proprietaria: string;
  foto_url: string | null;
  telefone: string;
  meta_faturamento_mensal: number;
}

function erroSupabase(error: { message: string }): ApiError {
  return new ApiError(500, null, error.message);
}

function naoEncontrado(mensagem: string): ApiError {
  return new ApiError(404, "RECURSO_NAO_ENCONTRADO", mensagem);
}

function validacaoInvalida(mensagem: string): ApiError {
  return new ApiError(422, "VALIDACAO_INVALIDA", mensagem);
}

async function usuarioAtual(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const userId = data.user?.id;
  if (!userId) throw new ApiError(401, "AUTH_TOKEN_AUSENTE", "Sua sessão expirou. Entre novamente.");
  return userId;
}

function paraPerfil(row: PerfilSalaoRow): Perfil {
  return {
    id: row.id,
    nome: row.nome_salao,
    proprietaria: row.nome_proprietaria,
    foto_url: row.foto_url,
    telefone_whatsapp: row.telefone || null,
    meta_faturamento_mensal: Number(row.meta_faturamento_mensal),
  };
}

/** "2026-09" → "2026-09-01" (primeiro dia da competência, como a coluna `date` guarda). */
function competenciaParaData(competencia: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia)) {
    throw validacaoInvalida("Competência deve estar no formato AAAA-MM.");
  }
  return `${competencia}-01`;
}

function competenciaAtual(): string {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
}

function validarDiaVencimento(dia: number): void {
  if (!Number.isInteger(dia) || dia < 1 || dia > 31) {
    throw validacaoInvalida("dia_vencimento deve ser um inteiro entre 1 e 31.");
  }
}

async function buscarCustoFixo(id: string, userId: string): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from("custos_fixos")
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw erroSupabase(error);
  if (!data) throw naoEncontrado("Custo fixo não encontrado");
  return data as { id: string };
}

export const PerfilApi = {
  async obter(): Promise<{ salao: Perfil }> {
    const userId = await usuarioAtual();
    const { data, error } = await supabase
      .from("perfil_salao")
      .select("id, nome_salao, nome_proprietaria, foto_url, telefone, meta_faturamento_mensal")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw erroSupabase(error);
    if (!data) throw naoEncontrado("Perfil do salão não encontrado");
    return { salao: paraPerfil(data as unknown as PerfilSalaoRow) };
  },

  async atualizar(body: PerfilBody): Promise<void> {
    const userId = await usuarioAtual();
    const patch: Record<string, unknown> = {
      nome_salao: body.nome,
      nome_proprietaria: body.proprietaria,
    };
    if (body.telefone_whatsapp !== undefined) patch["telefone"] = body.telefone_whatsapp ?? "";
    if (body.meta_faturamento_mensal !== undefined) {
      patch["meta_faturamento_mensal"] = body.meta_faturamento_mensal;
    }
    const { error } = await supabase.from("perfil_salao").update(patch).eq("user_id", userId);
    if (error) throw erroSupabase(error);
  },

  /** `competencia` no formato `AAAA-MM`; ausente vale o mês corrente. */
  async listarCustosFixos(competencia?: string): Promise<CustosFixosPagina> {
    const userId = await usuarioAtual();
    const comp = competencia ?? competenciaAtual();
    const dataCompetencia = competenciaParaData(comp);

    const { data: custos, error } = await supabase
      .from("custos_fixos")
      .select("id, descricao, valor, dia_vencimento")
      .eq("user_id", userId)
      .order("dia_vencimento", { ascending: true });
    if (error) throw erroSupabase(error);

    const ids = (custos ?? []).map((c) => c.id as string);
    const pagos = new Map<string, string>();
    if (ids.length > 0) {
      const { data: pagamentos, error: erroPagamentos } = await supabase
        .from("custos_fixos_pagamentos")
        .select("custo_fixo_id, pago_em")
        .eq("user_id", userId)
        .eq("competencia", dataCompetencia)
        .in("custo_fixo_id", ids);
      if (erroPagamentos) throw erroSupabase(erroPagamentos);
      for (const p of pagamentos ?? []) {
        pagos.set(p.custo_fixo_id as string, p.pago_em as string);
      }
    }

    let totalMensal = 0;
    let totalPago = 0;
    const lista = (custos ?? []).map((c) => {
      const valor = Number(c.valor);
      const pagoEm = pagos.get(c.id as string) ?? null;
      totalMensal += valor;
      if (pagoEm) totalPago += valor;
      return {
        id: c.id as string,
        descricao: c.descricao as string,
        valor,
        dia_vencimento: Number(c.dia_vencimento),
        competencia: comp,
        pago: pagoEm !== null,
        pago_em: pagoEm,
      };
    });

    return {
      total_mensal: totalMensal,
      total_pago: totalPago,
      total_pendente: totalMensal - totalPago,
      custos: lista,
    };
  },

  async criarCustoFixo(body: CustoFixoBody): Promise<void> {
    const userId = await usuarioAtual();
    validarDiaVencimento(body.dia_vencimento);
    const { error } = await supabase.from("custos_fixos").insert({
      user_id: userId,
      descricao: body.descricao,
      valor: body.valor,
      dia_vencimento: body.dia_vencimento,
    });
    if (error) throw erroSupabase(error);
  },

  async editarCustoFixo(id: string, body: Partial<CustoFixoBody>): Promise<void> {
    const userId = await usuarioAtual();
    await buscarCustoFixo(id, userId);
    if (body.dia_vencimento !== undefined) validarDiaVencimento(body.dia_vencimento);

    const patch: Record<string, unknown> = {};
    if (body.descricao !== undefined) patch["descricao"] = body.descricao;
    if (body.valor !== undefined) patch["valor"] = body.valor;
    if (body.dia_vencimento !== undefined) patch["dia_vencimento"] = body.dia_vencimento;
    if (Object.keys(patch).length === 0) return;

    const { error } = await supabase.from("custos_fixos").update(patch).eq("id", id);
    if (error) throw erroSupabase(error);
  },

  /** Apaga junto o histórico de pagamento (`on delete cascade` em `custos_fixos_pagamentos`). */
  async excluirCustoFixo(id: string): Promise<void> {
    const userId = await usuarioAtual();
    await buscarCustoFixo(id, userId);
    const { error } = await supabase.from("custos_fixos").delete().eq("id", id);
    if (error) throw erroSupabase(error);
  },

  /**
   * Marca (ou desmarca) o pagamento de **uma competência**.
   *
   * `pago: false` desmarca — errar o clique numa conta que ela não pagou é
   * comum, e sem isto a única saída seria apagar o cadastro do aluguel.
   * **Pagar não lança gasto**: o custo fixo já entra no resultado do mês
   * pelo perfil, criar um `gasto` aqui contaria o aluguel duas vezes.
   */
  async pagarCustoFixo(id: string, competencia: string, pago: boolean): Promise<void> {
    const userId = await usuarioAtual();
    await buscarCustoFixo(id, userId);
    const dataCompetencia = competenciaParaData(competencia);

    if (pago) {
      const { error } = await supabase
        .from("custos_fixos_pagamentos")
        .upsert(
          { custo_fixo_id: id, user_id: userId, competencia: dataCompetencia },
          { onConflict: "custo_fixo_id,competencia" },
        );
      if (error) throw erroSupabase(error);
    } else {
      const { error } = await supabase
        .from("custos_fixos_pagamentos")
        .delete()
        .eq("custo_fixo_id", id)
        .eq("competencia", dataCompetencia);
      if (error) throw erroSupabase(error);
    }
  },

  async obterHorarioFuncionamento(): Promise<HorarioFuncionamento> {
    const userId = await usuarioAtual();
    const { data, error } = await supabase
      .from("horario_funcionamento")
      .select("dia_semana, ativo, hora_inicio, hora_fim")
      .eq("user_id", userId)
      .order("dia_semana", { ascending: true });
    if (error) throw erroSupabase(error);
    return {
      horarios: (data ?? []).map((h) => ({
        dia_semana: Number(h.dia_semana),
        ativo: Boolean(h.ativo),
        hora_inicio: h.hora_inicio as string | null,
        hora_fim: h.hora_fim as string | null,
      })),
    };
  },

  /**
   * Substitui os 7 dias de uma vez — o servidor não faz diff (mesma
   * filosofia de PATCH serviços). Mesma validação de
   * `app/schemas/perfil.py`: os 7 dias (0–6) precisam vir, dia ativo exige
   * `hora_inicio < hora_fim`, dia inativo zera as horas mesmo que tenham
   * vindo preenchidas.
   */
  async salvarHorarioFuncionamento(horarios: HorarioDia[]): Promise<HorarioFuncionamento> {
    const userId = await usuarioAtual();

    const dias = [...horarios].map((h) => h.dia_semana).sort((a, b) => a - b);
    if (dias.length !== 7 || dias.some((d, i) => d !== i)) {
      throw validacaoInvalida("É preciso enviar exatamente um horário para cada dia da semana (0 a 6).");
    }
    for (const h of horarios) {
      if (h.dia_semana < 0 || h.dia_semana > 6) {
        throw validacaoInvalida("dia_semana deve estar entre 0 (domingo) e 6 (sábado).");
      }
      if (h.ativo && (!h.hora_inicio || !h.hora_fim || h.hora_inicio >= h.hora_fim)) {
        throw validacaoInvalida("hora_inicio e hora_fim são obrigatórios e hora_inicio deve ser menor que hora_fim quando ativo.");
      }
    }

    const linhas = horarios.map((h) => ({
      user_id: userId,
      dia_semana: h.dia_semana,
      ativo: h.ativo,
      hora_inicio: h.ativo ? h.hora_inicio : null,
      hora_fim: h.ativo ? h.hora_fim : null,
    }));
    const { error } = await supabase
      .from("horario_funcionamento")
      .upsert(linhas, { onConflict: "user_id,dia_semana" });
    if (error) throw erroSupabase(error);

    return this.obterHorarioFuncionamento();
  },

  /**
   * Link fixo por salão. `slug_agendamento` é gerado (e garantido único) no
   * banco pela migração 003 — aqui só lê e monta a URL. Sem domínio próprio
   * ainda (CLAUDE.md), então a URL aponta para o próprio front, mesma ideia
   * de `LINK_AGENDAMENTO_BASE_URL` que o FastAPI usava (default
   * `http://localhost:8082/agendar`).
   */
  async obterLinkAgendamento(): Promise<LinkAgendamento> {
    const userId = await usuarioAtual();
    const { data, error } = await supabase
      .from("perfil_salao")
      .select("slug_agendamento")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw erroSupabase(error);
    const slug = (data as { slug_agendamento?: string } | null)?.slug_agendamento;
    if (!slug) throw naoEncontrado("Perfil do salão não encontrado");

    const url = `${window.location.origin}/agendar/${slug}`;
    return { slug, url };
  },
} as const;
