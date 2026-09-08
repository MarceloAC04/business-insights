import { createFileRoute } from "@tanstack/react-router";
import {
  addMinutes,
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  CalendarDays,
  CalendarHeart,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  List as ListIcon,
  Pencil,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { EstoqueInsuficienteDialog, faltantesDoErro } from "@/components/EstoqueInsuficienteDialog";
import {
  Card,
  EmptyState,
  ListSkeleton,
  Money,
  Pill,
  SectionTitle,
  type BadgeTone,
} from "@/components/ui-kit";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AtendimentoBody } from "@/lib/api";
import { formatBRL, formatDate, formatHora, formatTelefone } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  textoDoErro,
  useAtendimentos,
  useCancelarAtendimento,
  useCriarAtendimento,
  useEditarAtendimento,
  useEstoque,
  useFinalizarAtendimento,
  useServicos,
} from "@/lib/queries";
import type { Atendimento, FaltanteEstoque, ItemEstoque, StatusAtendimento } from "@/lib/types";

export const Route = createFileRoute("/atendimentos")({
  head: () => ({
    meta: [
      { title: "Atendimentos — GlowApp" },
      {
        name: "description",
        content:
          "Agende, finalize e acompanhe o lucro de cada atendimento do salão, com baixa automática de produtos.",
      },
      { property: "og:title", content: "Atendimentos — GlowApp" },
      {
        property: "og:description",
        content: "Controle de agenda, valores cobrados, custos e lucro por atendimento.",
      },
    ],
  }),
  component: AtendimentosPage,
});

const statusInfo: Record<StatusAtendimento, { label: string; tone: BadgeTone }> = {
  agendado: { label: "Agendado", tone: "brand" },
  finalizado: { label: "Finalizado", tone: "positive" },
  cancelado: { label: "Cancelado", tone: "negative" },
};

type Periodo = "mes" | "proximos" | "todos";

/** `AAAA-MM-DD` no fuso local — `toISOString` daria o dia errado à noite. */
function diaIso(d: Date): string {
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/** A listagem do contrato é por intervalo: o filtro da tela vira `inicio`/`fim`. */
function intervalo(periodo: Periodo): { inicio: string; fim: string } {
  const hoje = new Date();
  if (periodo === "mes") {
    return {
      inicio: diaIso(new Date(hoje.getFullYear(), hoje.getMonth(), 1)),
      fim: diaIso(new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0)),
    };
  }
  if (periodo === "proximos") {
    const fim = new Date(hoje);
    fim.setDate(fim.getDate() + 30);
    return { inicio: diaIso(hoje), fim: diaIso(fim) };
  }
  return {
    inicio: `${hoje.getFullYear() - 1}-01-01`,
    fim: `${hoje.getFullYear()}-12-31`,
  };
}

/** ISO-8601 com o offset local, como o contrato pede. */
function paraIso(data: string, hora: string): string {
  const minutos = -new Date(`${data}T${hora}:00`).getTimezoneOffset();
  const sinal = minutos >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(minutos) / 60)).padStart(2, "0");
  const mm = String(Math.abs(minutos) % 60).padStart(2, "0");
  return `${data}T${hora}:00${sinal}${hh}:${mm}`;
}

function nomesDosServicos(a: Atendimento): string {
  return a.servicos.map((s) => s.nome).join(" + ");
}

/**
 * A duração pertence ao serviço cadastrado e pode estar ausente em serviços
 * antigos. Nesse caso, a agenda mostra a lacuna em vez de sugerir um término
 * que não foi informado.
 */
function intervaloHorario(
  atendimento: Atendimento,
  duracaoPorServico: Map<string, number | null>,
): string {
  const duracoes = atendimento.servicos.map((servico) =>
    servico.servico_id ? (duracaoPorServico.get(servico.servico_id) ?? null) : null,
  );
  if (!duracoes.every((duracao): duracao is number => typeof duracao === "number" && duracao > 0)) {
    return `${formatHora(atendimento.data)} · sem duração`;
  }

  const totalMinutos = duracoes.reduce((total, duracao) => total + duracao, 0);
  const termino = addMinutes(new Date(atendimento.data), totalMinutos);
  return `${formatHora(atendimento.data)}–${format(termino, "HH:mm")}`;
}

type Visao = "lista" | "calendario";

function AtendimentosPage() {
  const [visao, setVisao] = useState<Visao>("calendario");
  const [filtroStatus, setFiltroStatus] = useState<"todos" | StatusAtendimento>("todos");
  const [periodo, setPeriodo] = useState<Periodo>("mes");
  const [mesCalendario, setMesCalendario] = useState(() => {
    const hoje = new Date();
    return new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  });
  const [diaSelecionado, setDiaSelecionado] = useState(() => diaIso(new Date()));
  const [formAberto, setFormAberto] = useState(false);
  const [editando, setEditando] = useState<Atendimento | null>(null);
  const [finalizar, setFinalizar] = useState<Atendimento | null>(null);
  const [cancelar, setCancelar] = useState<Atendimento | null>(null);
  const [detalhe, setDetalhe] = useState<Atendimento | null>(null);
  const { data: catalogo } = useServicos();
  const duracaoPorServico = useMemo(
    () => new Map((catalogo?.servicos ?? []).map((servico) => [servico.id, servico.duracao_minutos])),
    [catalogo],
  );

  // No calendário quem manda no período é o mês exibido, não o seletor "Este mês".
  const { inicio, fim } = useMemo(
    () =>
      visao === "calendario"
        ? {
            inicio: diaIso(new Date(mesCalendario.getFullYear(), mesCalendario.getMonth(), 1)),
            fim: diaIso(new Date(mesCalendario.getFullYear(), mesCalendario.getMonth() + 1, 0)),
          }
        : intervalo(periodo),
    [visao, periodo, mesCalendario],
  );
  const status = filtroStatus === "todos" ? [] : [filtroStatus];

  const { data, isPending, isError, error } = useAtendimentos(inicio, fim, status);
  const cancelamento = useCancelarAtendimento();

  const lista = useMemo(
    () => (data?.atendimentos ?? []).slice().sort((a, b) => a.data.localeCompare(b.data)),
    [data],
  );

  const porDia = useMemo(() => {
    const mapa = new Map<string, Atendimento[]>();
    lista.forEach((a) => {
      const dia = diaIso(new Date(a.data));
      const atual = mapa.get(dia) ?? [];
      atual.push(a);
      mapa.set(dia, atual);
    });
    return mapa;
  }, [lista]);

  const atendimentosDoDia = useMemo(
    () => (porDia.get(diaSelecionado) ?? []).slice().sort((a, b) => a.data.localeCompare(b.data)),
    [porDia, diaSelecionado],
  );

  function abrirNovo() {
    setEditando(null);
    setFormAberto(true);
  }

  function abrirEditar(a: Atendimento) {
    setEditando(a);
    setFormAberto(true);
  }

  return (
    <AppShell
      titulo="Atendimentos"
      subtitulo={
        data
          ? `${data.quantidade} atendimentos • saldo de ${formatBRL(data.saldo_liquido)}`
          : "Agenda, valores e lucro de cada cliente"
      }
      acaoLabel="Agendar atendimento"
      onAcao={abrirNovo}
      conteudoAmplo
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Tabs value={visao} onValueChange={(v) => setVisao(v as Visao)}>
          <TabsList>
            <TabsTrigger value="lista">
              <ListIcon className="size-4" />
              Lista
            </TabsTrigger>
            <TabsTrigger value="calendario">
              <CalendarDays className="size-4" />
              Calendário
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {visao === "lista" ? (
          <Select value={periodo} onValueChange={(v) => setPeriodo(v as Periodo)}>
            <SelectTrigger className="h-11 w-[160px] rounded-xl bg-surface">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mes">Este mês</SelectItem>
              <SelectItem value="proximos">Próximos dias</SelectItem>
              <SelectItem value="todos">Todo o período</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
        <Select
          value={filtroStatus}
          onValueChange={(v) => setFiltroStatus(v as typeof filtroStatus)}
        >
          <SelectTrigger className="h-11 w-[150px] rounded-xl bg-surface">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos os status</SelectItem>
            <SelectItem value="agendado">Agendados</SelectItem>
            <SelectItem value="finalizado">Finalizados</SelectItem>
            <SelectItem value="cancelado">Cancelados</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isPending ? (
        <ListSkeleton linhas={5} />
      ) : isError ? (
        <EmptyState
          icon={<TriangleAlert className="size-5" />}
          titulo="Não deu para carregar a agenda"
          descricao={textoDoErro(error)}
        />
      ) : visao === "calendario" ? (
        <div className="grid grid-cols-1 gap-4 lg:min-h-[calc(100dvh-11rem)] lg:grid-cols-[minmax(0,1fr)_340px]">
          <CalendarioMes
            mes={mesCalendario}
            onMudarMes={setMesCalendario}
            porDia={porDia}
            diaSelecionado={diaSelecionado}
            onSelecionarDia={setDiaSelecionado}
            getHorario={(a) => intervaloHorario(a, duracaoPorServico)}
          />
          <div className="min-w-0">
            <SectionTitle>{formatDate(diaSelecionado)}</SectionTitle>
            {atendimentosDoDia.length === 0 ? (
              <EmptyState
                icon={<CalendarHeart className="size-5" />}
                titulo="Nada agendado neste dia"
                descricao="Escolha outro dia no calendário ou agende um novo atendimento."
                acao={<Button onClick={abrirNovo}>Agendar atendimento</Button>}
              />
            ) : (
              <div className="grid grid-cols-1 gap-3">
                {atendimentosDoDia.map((a) => (
                  <AtendimentoCard
                    key={a.id}
                    atendimento={a}
                    horario={intervaloHorario(a, duracaoPorServico)}
                    onVerDetalhes={() => setDetalhe(a)}
                    onFinalizar={() => setFinalizar(a)}
                    onEditar={() => abrirEditar(a)}
                    onCancelar={() => setCancelar(a)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      ) : lista.length === 0 ? (
        <EmptyState
          icon={<CalendarHeart className="size-5" />}
          titulo="Nenhum atendimento por aqui"
          descricao="Agende o primeiro atendimento do período para começar a acompanhar seu lucro."
          acao={<Button onClick={abrirNovo}>Agendar atendimento</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {lista.map((a) => (
            <AtendimentoCard
              key={a.id}
              atendimento={a}
              horario={intervaloHorario(a, duracaoPorServico)}
              onVerDetalhes={() => setDetalhe(a)}
              onFinalizar={() => setFinalizar(a)}
              onEditar={() => abrirEditar(a)}
              onCancelar={() => setCancelar(a)}
            />
          ))}
        </div>
      )}

      <FormularioAtendimento
        aberto={formAberto}
        onFechar={() => setFormAberto(false)}
        atendimento={editando}
      />
      <DetalhesAtendimento
        atendimento={detalhe}
        duracaoPorServico={duracaoPorServico}
        onFechar={() => setDetalhe(null)}
      />
      <DialogFinalizar atendimento={finalizar} onFechar={() => setFinalizar(null)} />

      <AlertDialog open={cancelar !== null} onOpenChange={(o) => !o && setCancelar(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar este atendimento?</AlertDialogTitle>
            <AlertDialogDescription>
              O atendimento de {cancelar?.cliente_nome} ficará marcado como cancelado e não entrará
              no faturamento do mês.
              {cancelar?.status === "finalizado"
                ? " Os produtos usados voltam para o estoque."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelamento.isPending}>Voltar</AlertDialogCancel>
            <AlertDialogAction
              disabled={cancelamento.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (!cancelar) return;
                cancelamento.mutate(cancelar.id, {
                  onSuccess: () => {
                    toast.success("Atendimento cancelado.");
                    setCancelar(null);
                  },
                  onError: (erro) => toast.error(textoDoErro(erro)),
                });
              }}
            >
              Sim, cancelar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}

const DIAS_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MAX_CHIPS_POR_DIA = 2;

function capitalizar(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function CalendarioMes({
  mes,
  onMudarMes,
  porDia,
  diaSelecionado,
  onSelecionarDia,
  getHorario,
}: {
  mes: Date;
  onMudarMes: (d: Date) => void;
  porDia: Map<string, Atendimento[]>;
  diaSelecionado: string;
  onSelecionarDia: (iso: string) => void;
  getHorario: (atendimento: Atendimento) => string;
}) {
  const semanas = useMemo(() => {
    const inicio = startOfWeek(startOfMonth(mes), { weekStartsOn: 0 });
    const fim = endOfWeek(endOfMonth(mes), { weekStartsOn: 0 });
    const dias = eachDayOfInterval({ start: inicio, end: fim });
    const linhas: Date[][] = [];
    for (let i = 0; i < dias.length; i += 7) linhas.push(dias.slice(i, i + 7));
    return linhas;
  }, [mes]);

  return (
    <Card className="flex flex-col overflow-hidden p-0 lg:h-full">
      <div className="flex items-center justify-between gap-2 border-b border-border p-3">
        <p className="font-display text-base font-semibold">
          {capitalizar(format(mes, "MMMM 'de' yyyy", { locale: ptBR }))}
        </p>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => onMudarMes(subMonths(mes, 1))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onMudarMes(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
          >
            Hoje
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => onMudarMes(addMonths(mes, 1))}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 border-b border-border text-center text-[10px] font-semibold tracking-wide text-muted-foreground uppercase sm:text-[11px]">
        {DIAS_SEMANA.map((d) => (
          <div key={d} className="py-2">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 lg:min-h-0 lg:flex-1 lg:auto-rows-fr">
        {semanas.flatMap((semana) =>
          semana.map((dia) => {
            const iso = diaIso(dia);
            const doDia = porDia.get(iso) ?? [];
            const foraDoMes = !isSameMonth(dia, mes);
            const selecionado = iso === diaSelecionado;
            const hoje = isToday(dia);
            return (
              <button
                key={iso}
                type="button"
                onClick={() => onSelecionarDia(iso)}
                className={cn(
                  "min-h-[64px] min-w-0 border-r border-b border-border p-1 text-left align-top last:border-r-0 sm:min-h-24 sm:p-1.5 lg:min-h-0",
                  foraDoMes && "bg-surface-2/60",
                  selecionado && "bg-accent/40 ring-1 ring-inset ring-primary",
                )}
              >
                <span
                  className={cn(
                    "inline-flex size-5 items-center justify-center rounded-full text-xs font-semibold",
                    foraDoMes ? "text-muted-foreground/50" : "text-foreground",
                    hoje && "bg-primary text-primary-foreground",
                  )}
                >
                  {dia.getDate()}
                </span>
                <div className="mt-1 flex flex-col gap-0.5">
                  {doDia.slice(0, MAX_CHIPS_POR_DIA).map((a) => (
                    <Pill
                      key={a.id}
                      tone={statusInfo[a.status].tone}
                      className="block w-full truncate rounded px-1 py-0.5 text-left text-[9px] leading-tight sm:text-[10px]"
                    >
                      <span className="block truncate">{getHorario(a)}</span>
                      <span className="hidden truncate sm:block">{a.cliente_nome}</span>
                    </Pill>
                  ))}
                  {doDia.length > MAX_CHIPS_POR_DIA ? (
                    <span className="px-1 text-[9px] font-medium text-muted-foreground">
                      +{doDia.length - MAX_CHIPS_POR_DIA} mais
                    </span>
                  ) : null}
                </div>
              </button>
            );
          }),
        )}
      </div>
    </Card>
  );
}

function AtendimentoCard({
  atendimento: a,
  horario,
  onVerDetalhes,
  onFinalizar,
  onEditar,
  onCancelar,
}: {
  atendimento: Atendimento;
  horario: string;
  onVerDetalhes: () => void;
  onFinalizar: () => void;
  onEditar: () => void;
  onCancelar: () => void;
}) {
  const emAberto = a.status === "agendado";
  const custo = emAberto ? a.custo_estimado : a.total_materiais;
  const lucro = emAberto ? a.saldo_estimado : a.saldo;

  return (
    <Card className="p-4">
      <button
        type="button"
        onClick={onVerDetalhes}
        aria-label={`Ver detalhes do atendimento de ${a.cliente_nome}`}
        className="block w-full cursor-pointer rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          <div className="min-w-0">
            <p className="truncate font-display text-base font-semibold">{a.cliente_nome}</p>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">{nomesDosServicos(a)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatDate(a.data)} • {horario}
              {a.cliente_telefone ? ` • ${a.cliente_telefone}` : ""}
            </p>
          </div>
          <Pill tone={statusInfo[a.status].tone}>{statusInfo[a.status].label}</Pill>
        </div>

        {/* Os valores reais e as previsões vêm prontos do servidor. */}
        <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-surface-2 p-3 text-center">
          <div>
            <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              Cobrado
            </p>
            <Money value={a.total_servicos} className="text-sm" />
          </div>
          <div>
            <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              {emAberto ? "Custo estimado" : "Custo"}
            </p>
            {custo === null || custo === undefined ? (
              <span className="text-xs text-muted-foreground">A confirmar</span>
            ) : (
              <Money value={custo} className="text-sm" />
            )}
          </div>
          <div>
            <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              {emAberto ? "Lucro estimado" : "Lucro"}
            </p>
            {lucro === null || lucro === undefined ? (
              <span className="text-xs text-muted-foreground">A confirmar</span>
            ) : (
              <Money value={lucro} colorir className="text-sm" />
            )}
          </div>
        </div>

        {a.materiais.length ? (
          <p className="mt-2 truncate text-xs text-muted-foreground">
            Produtos: {a.materiais.map((m) => `${m.nome} (${m.quantidade} ${m.unidade_consumo ?? ""})`).join(", ")}
          </p>
        ) : null}
      </button>

      <div className="mt-3 flex flex-wrap gap-2">
        {a.status === "agendado" ? (
          <>
            <Button size="sm" onClick={onFinalizar}>
              <CheckCircle2 className="size-4" />
              Finalizar
            </Button>
            <Button size="sm" variant="outline" onClick={onEditar}>
              <Pencil className="size-4" />
              Editar
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancelar}>
              <X className="size-4" />
              Cancelar
            </Button>
          </>
        ) : a.status === "finalizado" ? (
          <Button size="sm" variant="ghost" onClick={onCancelar}>
            <X className="size-4" />
            Cancelar
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function DetalhesAtendimento({
  atendimento,
  duracaoPorServico,
  onFechar,
}: {
  atendimento: Atendimento | null;
  duracaoPorServico: Map<string, number | null>;
  onFechar: () => void;
}) {
  if (!atendimento) return null;

  const horario = intervaloHorario(atendimento, duracaoPorServico);
  const emAberto = atendimento.status === "agendado";
  const custo = emAberto ? atendimento.custo_estimado : atendimento.total_materiais;
  const lucro = emAberto ? atendimento.saldo_estimado : atendimento.saldo;

  return (
    <Dialog open onOpenChange={(aberto) => !aberto && onFechar()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader className="pr-8">
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogTitle className="font-display">Detalhes do atendimento</DialogTitle>
              <DialogDescription className="mt-1">
                {formatDate(atendimento.data)} • {horario}
              </DialogDescription>
            </div>
            <Pill tone={statusInfo[atendimento.status].tone}>
              {statusInfo[atendimento.status].label}
            </Pill>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <section className="rounded-xl bg-surface-2 p-3">
            <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              Cliente
            </p>
            <p className="mt-1 font-medium">{atendimento.cliente_nome}</p>
            {atendimento.cliente_telefone ? (
              <p className="mt-0.5 text-sm text-muted-foreground">{atendimento.cliente_telefone}</p>
            ) : null}
          </section>

          <section>
            <p className="mb-2 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              Serviços
            </p>
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {atendimento.servicos.map((servico, indice) => (
                <li key={`${servico.servico_id ?? servico.nome}-${indice}`} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="min-w-0 truncate text-sm font-medium">{servico.nome}</span>
                  <span className="shrink-0 text-sm text-muted-foreground">
                    {formatBRL(servico.preco)}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {atendimento.materiais.length ? (
            <section>
              <p className="mb-2 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                Produtos utilizados
              </p>
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                {atendimento.materiais.map((material, indice) => (
                  <li key={`${material.item_estoque_id ?? material.nome}-${indice}`} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <span className="min-w-0 text-sm font-medium">
                      {material.nome}{" "}
                      <span className="text-muted-foreground">
                        × {material.quantidade} {material.unidade_consumo ?? ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm text-muted-foreground">
                      {formatBRL(material.preco * material.quantidade)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="grid grid-cols-3 gap-2 rounded-xl bg-surface-2 p-3 text-center">
            <div>
              <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                Cobrado
              </p>
              <Money value={atendimento.total_servicos} className="text-sm" />
            </div>
            <div>
              <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                {emAberto ? "Custo estimado" : "Custo"}
              </p>
              {custo === null || custo === undefined ? (
                <span className="text-xs text-muted-foreground">A confirmar</span>
              ) : (
                <Money value={custo} className="text-sm" />
              )}
            </div>
            <div>
              <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                {emAberto ? "Lucro estimado" : "Lucro"}
              </p>
              {lucro === null || lucro === undefined ? (
                <span className="text-xs text-muted-foreground">A confirmar</span>
              ) : (
                <Money value={lucro} colorir className="text-sm" />
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={onFechar}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FormularioAtendimento({
  aberto,
  onFechar,
  atendimento,
}: {
  aberto: boolean;
  onFechar: () => void;
  atendimento: Atendimento | null;
}) {
  const { data: catalogo } = useServicos();
  const servicos = catalogo?.servicos ?? [];
  const criar = useCriarAtendimento();
  const editar = useEditarAtendimento();

  const [cliente, setCliente] = useState("");
  const [telefone, setTelefone] = useState("");
  const [data, setData] = useState(diaIso(new Date()));
  const [hora, setHora] = useState("09:00");
  const [escolhidos, setEscolhidos] = useState<string[]>([]);
  const [chave, setChave] = useState("");

  // Sincroniza os campos quando o diálogo abre (padrão do protótipo: estado
  // derivado da chave, sem `useEffect`).
  const chaveAtual = `${String(aberto)}-${atendimento?.id ?? "novo"}`;
  if (chave !== chaveAtual) {
    setChave(chaveAtual);
    if (aberto) {
      const quando = atendimento ? new Date(atendimento.data) : new Date();
      setCliente(atendimento?.cliente_nome ?? "");
      setTelefone(atendimento?.cliente_telefone ?? "");
      setData(diaIso(quando));
      setHora(
        atendimento
          ? formatHora(atendimento.data)
          : `${String(quando.getHours()).padStart(2, "0")}:00`,
      );
      setEscolhidos(
        atendimento
          ? atendimento.servicos.map((s) => s.servico_id).filter((id): id is string => id !== null)
          : [],
      );
    }
  }

  const total = servicos.filter((s) => escolhidos.includes(s.id)).reduce((t, s) => t + s.preco, 0);
  const salvando = criar.isPending || editar.isPending;

  function alternar(id: string) {
    setEscolhidos((atual) => (atual.includes(id) ? atual.filter((x) => x !== id) : [...atual, id]));
  }

  function submeter(e: React.FormEvent) {
    e.preventDefault();
    if (escolhidos.length === 0) {
      toast.error("Escolha pelo menos um serviço.");
      return;
    }
    const body: AtendimentoBody = {
      cliente_nome: cliente.trim(),
      cliente_telefone: telefone.trim() === "" ? null : telefone.trim(),
      data: paraIso(data, hora),
      servicos: escolhidos.map((id) => ({ servico_id: id })),
    };
    const opcoes = {
      onSuccess: () => {
        onFechar();
        toast.success(atendimento ? "Atendimento atualizado." : "Atendimento agendado!");
      },
      onError: (erro: unknown) => toast.error(textoDoErro(erro)),
    };
    if (atendimento) editar.mutate({ id: atendimento.id, body }, opcoes);
    else criar.mutate(body, opcoes);
  }

  return (
    <Dialog open={aberto} onOpenChange={(o) => !o && onFechar()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display">
            {atendimento ? "Editar atendimento" : "Agendar atendimento"}
          </DialogTitle>
          <DialogDescription>Preencha os dados do atendimento.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submeter} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cliente">Cliente</Label>
            <Input
              id="cliente"
              value={cliente}
              onChange={(e) => setCliente(e.target.value)}
              className="h-11 rounded-xl"
              maxLength={80}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="telefone">Telefone (opcional)</Label>
            <Input
              id="telefone"
              value={telefone}
              onChange={(e) => setTelefone(formatTelefone(e.target.value))}
              className="h-11 rounded-xl"
              placeholder="(11) 90000-0000"
              inputMode="numeric"
              maxLength={15}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="data">Data</Label>
              <Input
                id="data"
                type="date"
                value={data}
                onChange={(e) => setData(e.target.value)}
                className="h-11 rounded-xl"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hora">Horário</Label>
              <Input
                id="hora"
                type="time"
                value={hora}
                onChange={(e) => setHora(e.target.value)}
                className="h-11 rounded-xl"
                required
              />
            </div>
          </div>

          {/*
            Um atendimento tem N serviços: "sobrancelha + cílios na mesma
            cadeira" é um atendimento só, e é assim que o saldo do dia fecha.
            O preço é o do catálogo, congelado no ato pelo servidor.
          */}
          <div className="space-y-1.5">
            <Label>Serviços</Label>
            <ul className="space-y-2">
              {servicos.map((s) => (
                <li key={s.id}>
                  <label className="flex items-center justify-between gap-3 rounded-xl border border-border p-2.5">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Checkbox
                        checked={escolhidos.includes(s.id)}
                        onCheckedChange={() => alternar(s.id)}
                      />
                      <span className="min-w-0 truncate text-sm font-medium">{s.nome}</span>
                    </span>
                    <span className="shrink-0 text-sm text-muted-foreground">
                      {formatBRL(s.preco)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {servicos.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Cadastre seus serviços no perfil para agendar.
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-between rounded-xl bg-surface-2 p-3 text-sm">
            <span className="text-muted-foreground">Total do atendimento</span>
            <Money value={total} />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onFechar} disabled={salvando}>
              Voltar
            </Button>
            <Button type="submit" disabled={salvando}>
              {salvando ? "Salvando..." : "Salvar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DialogFinalizar({
  atendimento,
  onFechar,
}: {
  atendimento: Atendimento | null;
  onFechar: () => void;
}) {
  const { data: estoque } = useEstoque();
  const { data: catalogo } = useServicos();
  const finalizar = useFinalizarAtendimento();

  const [quantidades, setQuantidades] = useState<Record<string, number>>({});
  const [chave, setChave] = useState("");
  const [faltantes, setFaltantes] = useState<FaltanteEstoque[] | null>(null);
  const [buscaOutrosProdutos, setBuscaOutrosProdutos] = useState("");

  const itens = estoque?.itens ?? [];
  const servicos = catalogo?.servicos ?? [];

  // Ao abrir, já vem marcado o que o serviço costuma gastar: ela não deveria
  // ter que lembrar quanta cola sai numa aplicação.
  const chaveAtual = atendimento?.id ?? "";
  if (chave !== chaveAtual) {
    setChave(chaveAtual);
    const inicial: Record<string, number> = {};
    atendimento?.servicos.forEach((s) => {
      const doCatalogo = servicos.find((x) => x.id === s.servico_id);
      doCatalogo?.produtos_padrao.forEach((p) => {
        inicial[p.item_estoque_id] = (inicial[p.item_estoque_id] ?? 0) + p.quantidade;
      });
    });
    setQuantidades(inicial);
    setFaltantes(null);
    setBuscaOutrosProdutos("");
  }

  if (!atendimento) return null;

  // Um dropdown por serviço, só com os produtos que o catálogo atribui a ele —
  // ela não precisa mais garimpar o item certo no meio de todo o estoque.
  const idsAtribuidos = new Set<string>();
  const gruposDeProdutos = atendimento.servicos
    .map((s) => servicos.find((x) => x.id === s.servico_id))
    .filter((s): s is (typeof servicos)[number] => s !== undefined)
    .map((servico) => {
      const doServico = servico.produtos_padrao
        .map((p) => itens.find((i) => i.id === p.item_estoque_id))
        .filter((i): i is (typeof itens)[number] => i !== undefined);
      doServico.forEach((i) => idsAtribuidos.add(i.id));
      return { id: servico.id, nome: servico.nome, itens: doServico };
    })
    .filter((grupo) => grupo.itens.length > 0);
  const outrosProdutos = itens.filter((i) => !idsAtribuidos.has(i.id));
  const buscaOutrosNormalizada = buscaOutrosProdutos.trim().toLocaleLowerCase("pt-BR");
  const outrosProdutosFiltrados = buscaOutrosNormalizada
    ? outrosProdutos.filter((item) => item.nome.toLocaleLowerCase("pt-BR").includes(buscaOutrosNormalizada))
    : outrosProdutos;

  // Sem anotar `MaterialEntrada[]`: a união com o material avulso (`nome`/`preco`)
  // apagaria `item_estoque_id` da prévia de custo logo abaixo. A conversão para o
  // corpo da requisição acontece na chamada.
  const materiais = Object.entries(quantidades)
    .filter(([, q]) => q > 0)
    .map(([item_estoque_id, quantidade]) => ({ item_estoque_id, quantidade }));

  // Prévia local do custo, só para ela ver o lucro antes de confirmar. O número
  // que vale é o que o servidor grava com o custo médio do momento da baixa.
  // Pote/frascos usam custo por uso, derivado desse mesmo custo médio.
  const custo = materiais.reduce((t, m) => {
    const item = itens.find((i) => i.id === m.item_estoque_id);
    return t + (item ? (item.custo_por_uso ?? item.custo_medio) * m.quantidade : 0);
  }, 0);
  const lucro = atendimento.total_servicos - custo;

  function concluir(confirmarEstoqueInsuficiente: boolean) {
    if (!atendimento) return;
    finalizar.mutate(
      {
        id: atendimento.id,
        body: {
          materiais,
          confirmar_estoque_insuficiente: confirmarEstoqueInsuficiente,
        },
      },
      {
        onSuccess: () => {
          setFaltantes(null);
          onFechar();
          toast.success("Atendimento finalizado!");
        },
        onError: (erro) => {
          // A5: a primeira passada não grava nada; o servidor diz o que falta e
          // ela decide se registra assim mesmo.
          const faltando = faltantesDoErro(erro);
          if (faltando && !confirmarEstoqueInsuficiente) setFaltantes(faltando);
          else {
            setFaltantes(null);
            toast.error(textoDoErro(erro));
          }
        },
      },
    );
  }

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onFechar()}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display">Finalizar atendimento</DialogTitle>
            <DialogDescription>
              {atendimento.cliente_nome} • {nomesDosServicos(atendimento)}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 rounded-xl bg-surface-2 p-3 text-center">
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase">Receita</p>
                <Money value={atendimento.total_servicos} className="text-sm" />
              </div>
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase">
                  Produtos
                </p>
                <Money value={custo} className="text-sm" />
              </div>
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase">Lucro</p>
                <Money value={lucro} colorir className="text-sm" />
              </div>
            </div>

            <div>
              <SectionTitle hint="Marque o que foi usado — o estoque é baixado automaticamente">
                Produtos utilizados
              </SectionTitle>
              <Accordion type="multiple">
                {gruposDeProdutos.map((grupo) => (
                  <AccordionItem key={grupo.id} value={grupo.id}>
                    <AccordionTrigger>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{grupo.nome}</span>
                        <Pill tone="neutral">
                          {grupo.itens.length} {grupo.itens.length === 1 ? "item" : "itens"}
                        </Pill>
                      </span>
                    </AccordionTrigger>
                    <AccordionContent>
                      <ListaDeProdutos
                        itens={grupo.itens}
                        quantidades={quantidades}
                        onMudar={setQuantidades}
                      />
                    </AccordionContent>
                  </AccordionItem>
                ))}
                {outrosProdutos.length > 0 ? (
                  <AccordionItem value="outros">
                    <AccordionTrigger>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">Outros produtos</span>
                        <Pill tone="neutral">
                          {outrosProdutos.length} {outrosProdutos.length === 1 ? "item" : "itens"}
                        </Pill>
                      </span>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        <div className="relative">
                          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            value={buscaOutrosProdutos}
                            onChange={(evento) => setBuscaOutrosProdutos(evento.target.value)}
                            className="pl-9"
                            placeholder="Buscar produto por nome"
                            aria-label="Buscar outro produto por nome"
                          />
                        </div>
                        {outrosProdutosFiltrados.length ? (
                          <ListaDeProdutos
                            itens={outrosProdutosFiltrados}
                            quantidades={quantidades}
                            onMudar={setQuantidades}
                          />
                        ) : (
                          <p className="rounded-xl border border-dashed border-border p-3 text-center text-sm text-muted-foreground">
                            Nenhum produto encontrado.
                          </p>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ) : null}
              </Accordion>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={onFechar} disabled={finalizar.isPending}>
              Voltar
            </Button>
            <Button onClick={() => concluir(false)} disabled={finalizar.isPending}>
              Finalizar atendimento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EstoqueInsuficienteDialog
        faltantes={faltantes}
        acao="finalizar este atendimento"
        confirmando={finalizar.isPending}
        onCancelar={() => setFaltantes(null)}
        onConfirmar={() => concluir(true)}
      />
    </>
  );
}

function ListaDeProdutos({
  itens,
  quantidades,
  onMudar,
}: {
  itens: ItemEstoque[];
  quantidades: Record<string, number>;
  onMudar: (atualizar: (s: Record<string, number>) => Record<string, number>) => void;
}) {
  return (
    <ul className="space-y-2">
      {itens.map((p) => {
        const quantidade = quantidades[p.id] ?? 0;
        return (
          <li
            key={p.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-border p-2.5"
          >
            <label className="flex min-w-0 items-center gap-2.5">
              <Checkbox
                checked={quantidade > 0}
                onCheckedChange={(v) => onMudar((s) => ({ ...s, [p.id]: v ? 1 : 0 }))}
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{p.nome}</span>
                <span className="block text-xs text-muted-foreground">
                  {p.modo_controle === "rendimento_usos"
                    ? `Disponível: ${p.usos_disponiveis ?? 0} usos • ${formatBRL(p.custo_por_uso ?? 0)}/uso`
                    : `Saldo: ${p.quantidade_atual} ${p.unidade} • ${formatBRL(p.custo_medio)}`}
                </span>
              </span>
            </label>
            {quantidade > 0 ? (
              <Input
                inputMode="decimal"
                step="any"
                min={1}
                value={quantidade}
                onChange={(e) =>
                  onMudar((s) => ({ ...s, [p.id]: Number(e.target.value.replace(",", ".")) }))
                }
                className="h-9 w-16 rounded-lg text-center"
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
