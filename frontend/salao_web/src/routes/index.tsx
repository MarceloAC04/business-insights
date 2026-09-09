import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarPlus,
  Crown,
  Eye,
  EyeOff,
  Lightbulb,
  Package,
  Receipt,
  Target,
  TrendingUp,
  TriangleAlert,
  Users,
  Wallet,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AppShell } from "@/components/AppShell";
import {
  Card,
  CardsSkeleton,
  EmptyState,
  Money,
  Pill,
  SectionTitle,
  StatCard,
} from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatBRL, formatDate, formatPercent, MESES, nomeMes, pluralizar } from "@/lib/format";
import {
  textoDoErro,
  useEstoque,
  useGastos,
  useResumo,
  useResumoAnual,
  useSessao,
} from "@/lib/queries";
import type { ResumoAnual, ResumoComparacao, ResumoMensal, ValorComparado } from "@/lib/types";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Resumo financeiro — GlowApp" },
      {
        name: "description",
        content:
          "Veja em segundos quanto você faturou, gastou e lucrou no mês, além de pendências e produtos para repor.",
      },
      { property: "og:title", content: "Resumo financeiro — GlowApp" },
      {
        property: "og:description",
        content: "Faturamento, gastos, lucro, ticket médio e alertas do seu salão em uma tela.",
      },
    ],
  }),
  component: ResumoPage,
});

const hoje = new Date();
const anoAtual = hoje.getFullYear();
const mesAtual = hoje.getMonth() + 1;
const VALOR_OCULTO = "••••";

/** Rótulo curto do eixo do gráfico: "Set/26". */
function rotuloDoPonto(ano: number, mes: number): string {
  return `${nomeMes(mes).slice(0, 3)}/${String(ano).slice(2)}`;
}

function formatarVariacao(valor: number | null): string {
  return valor === null ? "Sem base" : `${valor >= 0 ? "+" : ""}${formatPercent(valor)}`;
}

function corDaVariacao(valor: number | null, aumentaEPositivo: boolean): string {
  if (valor === null || valor === 0) return "text-muted-foreground";
  const positivo = aumentaEPositivo ? valor > 0 : valor < 0;
  return positivo ? "text-positive" : "text-negative";
}

function ComparacaoItem({
  label,
  valor,
  aumentaEPositivo,
  mostrarValores,
}: {
  label: string;
  valor: ValorComparado;
  aumentaEPositivo: boolean;
  mostrarValores: boolean;
}) {
  return (
    <div className="min-w-0 rounded-xl bg-surface-2 p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold">
        {mostrarValores ? formatBRL(valor.atual) : VALOR_OCULTO}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Antes: {mostrarValores ? formatBRL(valor.anterior) : VALOR_OCULTO}
      </p>
      <p className={`mt-1 text-xs font-semibold ${corDaVariacao(valor.variacao_percentual, aumentaEPositivo)}`}>
        {formatarVariacao(valor.variacao_percentual)}
      </p>
    </div>
  );
}

function ComparacaoCard({
  comparacao,
  anual,
  mostrarValores,
}: {
  comparacao: ResumoComparacao;
  anual: boolean;
  mostrarValores: boolean;
}) {
  return (
    <Card className="p-4">
      <SectionTitle hint={anual ? "Ano anterior" : "Mês anterior"}>
        Comparação com {anual ? "o ano anterior" : "o mês anterior"}
      </SectionTitle>
      <div className="grid gap-3 sm:grid-cols-3">
        <ComparacaoItem
          label="Faturamento"
          valor={comparacao.faturamento}
          aumentaEPositivo
          mostrarValores={mostrarValores}
        />
        <ComparacaoItem
          label="Gastos"
          valor={comparacao.gastos}
          aumentaEPositivo={false}
          mostrarValores={mostrarValores}
        />
        <ComparacaoItem
          label="Lucro"
          valor={comparacao.lucro}
          aumentaEPositivo
          mostrarValores={mostrarValores}
        />
      </div>
      {!mostrarValores ? (
        <p className="mt-3 text-xs text-muted-foreground">Valores financeiros ocultos</p>
      ) : null}
    </Card>
  );
}

function ResumoPage() {
  const navigate = useNavigate();
  const [periodo, setPeriodo] = useState<"mes" | "ano">("mes");
  const [mes, setMes] = useState(mesAtual);
  const [ano, setAno] = useState(anoAtual);
  const [mostrarValores, setMostrarValores] = useState(true);

  // Recharts mede o container no cliente: no SSR o gráfico sairia com 0px.
  const [montado, setMontado] = useState(false);
  useEffect(() => setMontado(true), []);

  const { data: sessao } = useSessao();
  const resumoMensalQuery = useResumo(ano, mes, periodo === "mes");
  const resumoAnualQuery = useResumoAnual(ano, periodo === "ano");
  const resumo: ResumoMensal | ResumoAnual | undefined =
    periodo === "mes" ? resumoMensalQuery.data : resumoAnualQuery.data;
  const isPending = periodo === "mes" ? resumoMensalQuery.isPending : resumoAnualQuery.isPending;
  const isError = periodo === "mes" ? resumoMensalQuery.isError : resumoAnualQuery.isError;
  const error = periodo === "mes" ? resumoMensalQuery.error : resumoAnualQuery.error;
  const resumoMensal = periodo === "mes" ? (resumo as ResumoMensal | undefined) : undefined;
  const resumoAnual = periodo === "ano" ? (resumo as ResumoAnual | undefined) : undefined;
  const { data: gastos } = useGastos(ano, mes);
  const { data: estoque } = useEstoque();

  // A API devolve o nome da proprietária. Este filtro também protege a saudação
  // caso uma sessão antiga ou uma resposta malformada traga o e-mail no campo.
  const nomeDaUsuario = sessao?.usuario?.nome.trim() ?? "";
  const primeiroNome = nomeDaUsuario.includes("@") ? "" : (nomeDaUsuario.split(/\s+/)[0] ?? "");

  const serie = useMemo(
    () =>
      ((periodo === "ano" ? resumoAnual?.historico_doze_meses : resumoMensal?.historico_seis_meses) ?? []).map((p) => ({
        mes: periodo === "ano" ? nomeMes(p.mes).slice(0, 3) : rotuloDoPonto(p.ano, p.mes),
        receitas: p.receitas,
        despesas: p.despesas,
      })),
    [periodo, resumoAnual, resumoMensal],
  );

  // Só os pendentes, do mais próximo de vencer para o mais distante.
  const proximos = useMemo(
    () =>
      (gastos?.gastos ?? [])
        .filter((g) => !g.pago)
        .sort((a, b) => a.vence_em_dias - b.vence_em_dias)
        .slice(0, 4),
    [gastos],
  );

  // Quem classifica o item é o servidor (`status`), não a tela.
  const baixos = useMemo(() => (estoque?.itens ?? []).filter((i) => i.status !== "ok"), [estoque]);

  const servicos = resumo?.receita.servicos_mais_realizados ?? [];
  const melhor = servicos[0];
  const comparacao = resumo?.comparacao;
  const variacao = comparacao?.lucro.variacao_percentual ?? 0;
  const temAnterior = comparacao?.lucro.variacao_percentual !== null && comparacao?.lucro.variacao_percentual !== undefined;
  const mesAnterior = mes === 1 ? 12 : mes - 1;

  const metaFaturamento = periodo === "ano" ? resumoAnual?.meta_faturamento_anual : resumoMensal?.meta_faturamento_mensal;
  const metaProgresso =
    resumo && metaFaturamento && metaFaturamento > 0
      ? Math.min(100, (resumo.entrou / metaFaturamento) * 100)
      : 0;
  const rotuloPeriodo = periodo === "ano" ? "ano" : "mês";

  const insights: string[] = [];
  if (resumo) {
    if (resumo.alerta_zero_a_zero) {
      insights.push(
        `Você faturou bem, mas os gastos comeram quase tudo: o ${rotuloPeriodo} está no zero a zero.`,
      );
    }
    if (temAnterior) {
      insights.push(
        variacao >= 0
          ? `Seu lucro aumentou ${formatPercent(Math.abs(variacao))} em relação a ${periodo === "ano" ? ano - 1 : nomeMes(mesAnterior)}.`
          : `Seu lucro caiu ${formatPercent(Math.abs(variacao))} em relação a ${periodo === "ano" ? ano - 1 : nomeMes(mesAnterior)}.`,
      );
    }
    if (resumo.insights.servico_mais_lucrativo) {
      insights.push(
        `${resumo.insights.servico_mais_lucrativo.nome} foi o serviço mais lucrativo do ${rotuloPeriodo}.`,
      );
    }
    if (resumo.receita.quantidade_kits_vendidos > 0) {
      insights.push(
        `Você vendeu ${resumo.receita.quantidade_kits_vendidos} ${pluralizar(resumo.receita.quantidade_kits_vendidos, "kit")}, somando ${formatBRL(resumo.receita.total_kits)}.`,
      );
    }
    if (baixos.length) {
      insights.push(
        `${baixos.length} ${pluralizar(baixos.length, "produto")} ${baixos.length === 1 ? "precisa" : "precisam"} de reposição.`,
      );
    }
    if (metaProgresso < 80 && metaFaturamento && metaFaturamento > 0) {
      insights.push(
        `Você alcançou ${formatPercent(metaProgresso)} da meta de faturamento de ${formatBRL(metaFaturamento)}.`,
      );
    }
  }

  return (
    <AppShell
      titulo={primeiroNome ? `Olá, ${primeiroNome}` : "Resumo"}
      subtitulo={periodo === "ano" ? `Resumo anual de ${ano}` : `Resumo de ${nomeMes(mes)} de ${ano}`}
      acaoLabel="Agendar atendimento"
      onAcao={() => void navigate({ to: "/atendimentos" })}
      conteudoAmplo
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex h-11 rounded-xl border border-border bg-surface p-1">
          <Button
            type="button"
            size="sm"
            variant={periodo === "mes" ? "default" : "ghost"}
            className="h-9 rounded-lg px-3"
            onClick={() => setPeriodo("mes")}
          >
            Mensal
          </Button>
          <Button
            type="button"
            size="sm"
            variant={periodo === "ano" ? "default" : "ghost"}
            className="h-9 rounded-lg px-3"
            onClick={() => setPeriodo("ano")}
          >
            Anual
          </Button>
        </div>
        {periodo === "mes" ? (
          <Select value={String(mes)} onValueChange={(v) => setMes(Number(v))}>
            <SelectTrigger className="h-11 w-[150px] rounded-xl bg-surface">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MESES.map((m, i) => (
                <SelectItem key={m} value={String(i + 1)}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Select value={String(ano)} onValueChange={(v) => setAno(Number(v))}>
          <SelectTrigger className="h-11 w-[110px] rounded-xl bg-surface">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[anoAtual - 1, anoAtual].map((a) => (
              <SelectItem key={a} value={String(a)}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-11 w-11 rounded-xl"
          title={mostrarValores ? "Ocultar valores financeiros" : "Mostrar valores financeiros"}
          aria-label={mostrarValores ? "Ocultar valores financeiros" : "Mostrar valores financeiros"}
          onClick={() => setMostrarValores((visivel) => !visivel)}
        >
          {mostrarValores ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
      </div>

      {isPending ? (
        <CardsSkeleton qtd={6} />
      ) : isError || !resumo ? (
        <EmptyState
          icon={<TriangleAlert className="size-5" />}
          titulo="Não deu para carregar o resumo"
          descricao={textoDoErro(error)}
        />
      ) : (
        <div className="space-y-4">
          {/* Lucro em destaque */}
          <StatCard
            label={resumo.saldo_final >= 0 ? `Lucro do ${rotuloPeriodo}` : `Prejuízo do ${rotuloPeriodo}`}
            value={mostrarValores ? formatBRL(resumo.saldo_final) : VALOR_OCULTO}
            destaque
            tone={resumo.saldo_final >= 0 ? "positive" : "negative"}
            icon={
              resumo.saldo_final >= 0 ? (
                <TrendingUp className="size-5" />
              ) : (
                <ArrowDownRight className="size-5" />
              )
            }
            hint={
              !mostrarValores
                ? "Valores financeiros ocultos"
                : temAnterior
                ? `${variacao >= 0 ? "+" : "-"}${formatPercent(Math.abs(variacao))} em relação a ${periodo === "ano" ? ano - 1 : nomeMes(mesAnterior)}`
                : `Sem comparação com ${periodo === "ano" ? "o ano" : "o mês"} anterior`
            }
          />

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatCard
              label="Faturamento"
              value={mostrarValores ? formatBRL(resumo.entrou) : VALOR_OCULTO}
              icon={<Wallet className="size-4" />}
            />
            <StatCard
              label="Gastos"
              value={mostrarValores ? formatBRL(resumo.saiu) : VALOR_OCULTO}
              icon={<Receipt className="size-4" />}
            />
            <StatCard
              label="Margem de lucro"
              value={mostrarValores ? formatPercent(resumo.insights.margem_lucro_percentual, 1) : VALOR_OCULTO}
              icon={<Target className="size-4" />}
            />
            <StatCard
              label="Ticket médio"
              value={mostrarValores ? formatBRL(resumo.insights.ticket_medio) : VALOR_OCULTO}
              icon={<ArrowUpRight className="size-4" />}
            />
            <StatCard
              label="Atendimentos"
              value={String(resumo.receita.quantidade_atendimentos)}
              icon={<Users className="size-4" />}
              hint={`finalizados no ${rotuloPeriodo}`}
            />
          </div>

          {comparacao ? (
            <ComparacaoCard
              comparacao={comparacao}
              anual={periodo === "ano"}
              mostrarValores={mostrarValores}
            />
          ) : null}

          {/* Atalhos */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Button
              variant="outline"
              className="h-14 justify-start gap-3 rounded-2xl bg-surface"
              onClick={() => void navigate({ to: "/atendimentos" })}
            >
              <span className="grid size-9 place-items-center rounded-xl bg-accent text-accent-foreground">
                <CalendarPlus className="size-4" />
              </span>
              Agendar atendimento
            </Button>
            <Button
              variant="outline"
              className="h-14 justify-start gap-3 rounded-2xl bg-surface"
              onClick={() => void navigate({ to: "/gastos" })}
            >
              <span className="grid size-9 place-items-center rounded-xl bg-accent text-accent-foreground">
                <Receipt className="size-4" />
              </span>
              Novo gasto
            </Button>
          </div>

          {/* Gráfico */}
          <Card className="p-4">
            <SectionTitle hint={periodo === "ano" ? `Meses de ${ano}` : "Últimos 6 meses"}>
              Receitas e despesas
            </SectionTitle>
            <div className="h-64 w-full">
              {!mostrarValores ? (
                <div className="grid h-full place-items-center rounded-xl bg-surface-2 text-sm text-muted-foreground">
                  Valores financeiros ocultos
                </div>
              ) : montado ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={serie} margin={{ top: 8, right: 4, bottom: 0, left: -18 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="mes" tickLine={false} axisLine={false} fontSize={12} />
                    <YAxis tickLine={false} axisLine={false} fontSize={11} width={56} />
                    <Tooltip
                      formatter={(v: number) => formatBRL(v)}
                      contentStyle={{
                        borderRadius: 12,
                        border: "1px solid var(--border)",
                        fontSize: 12,
                      }}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                    <Bar
                      dataKey="receitas"
                      name="Receitas"
                      fill="var(--primary)"
                      radius={[6, 6, 0, 0]}
                    />
                    <Bar
                      dataKey="despesas"
                      name="Despesas"
                      fill="var(--primary-light)"
                      radius={[6, 6, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : null}
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Serviço mais lucrativo + insights */}
            <div className="space-y-4">
              <Card className="p-4">
                <SectionTitle>Serviço mais lucrativo</SectionTitle>
                {melhor ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3 rounded-xl bg-accent/60 p-3">
                      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-gradient text-primary-foreground">
                        <Crown className="size-5" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{melhor.nome}</p>
                        <p className="text-xs text-muted-foreground">
                          {melhor.quantidade} {pluralizar(melhor.quantidade, "atendimento")} • lucro de{" "}
                          {mostrarValores ? <Money value={melhor.lucro} /> : VALOR_OCULTO}
                        </p>
                      </div>
                    </div>
                    {servicos.slice(1, 4).map((s) => (
                      <div
                        key={s.nome}
                        className="flex items-center justify-between gap-3 border-t border-border pt-2 text-sm"
                      >
                        <span className="min-w-0 truncate text-muted-foreground">{s.nome}</span>
                        {mostrarValores ? <Money value={s.lucro} colorir /> : <span>{VALOR_OCULTO}</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    titulo="Nenhum atendimento finalizado"
                    descricao="Finalize um atendimento para ver qual serviço dá mais lucro."
                  />
                )}
              </Card>

              <Card className="p-4">
                <SectionTitle hint="Gerado a partir dos seus números">Para você saber</SectionTitle>
                {!mostrarValores ? (
                  <p className="text-sm text-muted-foreground">
                    Valores financeiros ocultos. Toque no olho para visualizar.
                  </p>
                ) : insights.length ? (
                  <ul className="space-y-2">
                    {insights.map((texto) => (
                      <li key={texto} className="flex items-start gap-2.5 text-sm">
                        <Lightbulb className="mt-0.5 size-4 shrink-0 text-primary-accent" />
                        <span className="text-muted-foreground">{texto}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Ainda não há movimento suficiente neste mês para gerar observações.
                  </p>
                )}
              </Card>
            </div>

            {/* Próximos gastos + estoque */}
            <div className="space-y-4">
              <Card className="p-4">
                <SectionTitle
                  action={
                    <Link to="/gastos" className="text-xs font-semibold text-primary-accent">
                      Ver todos
                    </Link>
                  }
                >
                  Próximos gastos a vencer
                </SectionTitle>
                {proximos.length ? (
                  <ul className="divide-y divide-border">
                    {proximos.map((g) => (
                      <li key={g.id} className="flex items-center justify-between gap-3 py-2.5">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{g.nome}</p>
                          <p className="text-xs text-muted-foreground">
                            Vence em {formatDate(g.prazo_pagamento)}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          {mostrarValores ? (
                            <Money value={g.valor} className="text-sm" />
                          ) : (
                            <span className="text-sm font-semibold">{VALOR_OCULTO}</span>
                          )}
                          <div className="mt-1">
                            <Pill tone={g.vence_em_dias < 0 ? "negative" : "warning"}>
                              {g.vence_em_dias < 0 ? "Vencido" : "Pendente"}
                            </Pill>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState
                    titulo="Nada pendente"
                    descricao="Todos os gastos do período estão pagos. Ótimo trabalho!"
                  />
                )}
              </Card>

              <Card tone={baixos.length ? "warning" : "default"} className="p-4">
                <SectionTitle
                  action={
                    <Link to="/estoque" className="text-xs font-semibold text-primary-accent">
                      Ver estoque
                    </Link>
                  }
                >
                  Estoque para repor
                </SectionTitle>
                {baixos.length ? (
                  <ul className="space-y-2">
                    {baixos.slice(0, 5).map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-3 text-sm">
                        <span className="flex min-w-0 items-center gap-2">
                          <Package className="size-4 shrink-0 text-warning" />
                          <span className="truncate">{p.nome}</span>
                        </span>
                        <Pill tone={p.status === "alerta" ? "warning" : "negative"}>
                          {p.quantidade_atual} {p.unidade}
                        </Pill>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Todos os produtos estão com estoque saudável.
                  </p>
                )}
              </Card>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
