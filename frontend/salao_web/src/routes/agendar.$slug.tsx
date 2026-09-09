import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  CalendarCheck,
  Check,
  CheckCircle2,
  Clock,
  Instagram,
  MapPin,
  MessageCircle,
  Pencil,
  Scissors,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Card, EmptyState, ListSkeleton, Money, Pill, SectionTitle } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatDate, formatTelefone } from "@/lib/format";
import {
  textoDoErro,
  useAgendamentoPublico,
  useAgendarPublico,
  useHorariosDisponiveisPublico,
} from "@/lib/queries";

export const Route = createFileRoute("/agendar/$slug")({
  head: () => ({
    meta: [
      { title: "Agendar horário" },
      {
        name: "description",
        content: "Marque seu horário direto com o salão, sem precisar ligar.",
      },
    ],
  }),
  component: AgendarPublicoPage,
});

/** "AAAA-MM-DD" de hoje, no fuso do navegador — só para o mínimo do input. */
function hojeISO(): string {
  const hoje = new Date();
  const mes = String(hoje.getMonth() + 1).padStart(2, "0");
  const dia = String(hoje.getDate()).padStart(2, "0");
  return `${hoje.getFullYear()}-${mes}-${dia}`;
}

function telefoneValido(telefone: string): boolean {
  return telefone.replace(/\D/g, "").length >= 10;
}

function linkWhatsApp(telefone: string): string | null {
  const numero = telefone.replace(/\D/g, "");
  return numero.length >= 10 ? `https://wa.me/${numero}` : null;
}

function linkInstagram(instagram: string): string | null {
  const valor = instagram.trim();
  if (!valor) return null;
  if (/^https?:\/\//i.test(valor)) return valor;
  const usuario = valor
    .replace(/^@/, "")
    .replace(/^instagram\.com\//i, "")
    .trim();
  return usuario ? `https://instagram.com/${encodeURIComponent(usuario)}` : null;
}

function mostrarHorario(inicio: string | null, fim: string | null): string | null {
  return inicio && fim ? `${inicio.slice(0, 5)} às ${fim.slice(0, 5)}` : null;
}

const DIAS_SEMANA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

type Etapa = 1 | 2 | 3;

const ETAPAS: { n: Etapa; label: string }[] = [
  { n: 1, label: "Você" },
  { n: 2, label: "Serviço" },
  { n: 3, label: "Confirmar" },
];

/** Indicador de progresso das 3 etapas — dá o contexto de "quanto falta". */
function EtapasIndicador({ atual }: { atual: Etapa }) {
  return (
    <div className="mb-6 flex items-center">
      {ETAPAS.map((etapa, i) => (
        <div key={etapa.n} className="flex flex-1 items-center last:flex-none">
          <div className="flex flex-col items-center gap-1">
            <span
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold transition-colors duration-300",
                etapa.n < atual
                  ? "bg-primary text-primary-foreground"
                  : etapa.n === atual
                    ? "bg-primary text-primary-foreground ring-4 ring-primary/20"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {etapa.n < atual ? <Check className="size-3.5" /> : etapa.n}
            </span>
            <span
              className={cn(
                "text-[10px] font-medium whitespace-nowrap",
                etapa.n <= atual ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {etapa.label}
            </span>
          </div>
          {i < ETAPAS.length - 1 ? (
            <span
              className={cn(
                "mx-2 h-0.5 flex-1 rounded-full transition-colors duration-300",
                etapa.n < atual ? "bg-primary" : "bg-muted",
              )}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function AgendarPublicoPage() {
  const { slug } = Route.useParams();
  const { data: pagina, isPending, isError } = useAgendamentoPublico(slug);

  const [etapa, setEtapa] = useState<Etapa>(1);
  const [direcao, setDirecao] = useState<"avancar" | "voltar">("avancar");

  const [clienteNome, setClienteNome] = useState("");
  const [clienteTelefone, setClienteTelefone] = useState("");
  const [servicoIds, setServicoIds] = useState<string[]>([]);
  const [data, setData] = useState(hojeISO());
  const [horario, setHorario] = useState<string | null>(null);

  const { data: disponibilidade, isFetching: buscandoHorarios } = useHorariosDisponiveisPublico(
    slug,
    data,
    servicoIds,
  );
  const agendar = useAgendarPublico(slug);

  const servicos = useMemo(() => pagina?.servicos ?? [], [pagina?.servicos]);
  const servicosEscolhidos = useMemo(
    () => servicos.filter((s) => servicoIds.includes(s.id)),
    [servicos, servicoIds],
  );
  const precoTotal = servicosEscolhidos.reduce((t, s) => t + s.preco, 0);
  const servicosPorCategoria = useMemo(() => {
    const grupos = new Map<string, typeof servicos>();
    servicos.forEach((servico) => {
      const categoria = servico.categoria?.trim() || "Outros";
      grupos.set(categoria, [...(grupos.get(categoria) ?? []), servico]);
    });
    return [...grupos.entries()];
  }, [servicos]);
  const whatsapp = linkWhatsApp(pagina?.salao.telefone_whatsapp ?? "");
  const instagram = linkInstagram(pagina?.salao.instagram_url ?? "");
  const mapa = pagina?.salao.endereco.trim()
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(pagina.salao.endereco)}`
    : null;

  const irPara = (destino: Etapa) => {
    setDirecao(destino > etapa ? "avancar" : "voltar");
    setEtapa(destino);
  };

  const alternarServico = (id: string) => {
    setHorario(null);
    setServicoIds((atual) => (atual.includes(id) ? atual.filter((x) => x !== id) : [...atual, id]));
  };

  const confirmar = () => {
    if (!horario || !clienteNome.trim() || !telefoneValido(clienteTelefone)) return;
    agendar.mutate({
      cliente_nome: clienteNome.trim(),
      cliente_telefone: clienteTelefone.trim(),
      data: `${data}T${horario}:00-03:00`,
      servicos: servicoIds.map((servico_id) => ({ servico_id })),
    });
  };

  if (isPending) {
    return (
      <div className="mx-auto min-h-screen max-w-lg px-5 py-10">
        <ListSkeleton linhas={4} />
      </div>
    );
  }

  if (isError || !pagina) {
    return (
      <div className="mx-auto flex min-h-screen max-w-lg items-center px-5 py-10">
        <EmptyState
          icon={<TriangleAlert className="size-5" />}
          titulo="Link inválido"
          descricao="Esse link de agendamento não existe ou não está mais ativo. Confira com o salão."
        />
      </div>
    );
  }

  if (agendar.isSuccess) {
    const resultado = agendar.data;
    return (
      <div className="mx-auto flex min-h-screen max-w-lg items-center px-5 py-10">
        <Card className="w-full animate-in fade-in zoom-in-95 p-6 text-center duration-300">
          <div className="mx-auto grid size-14 place-items-center rounded-full bg-positive-soft text-positive">
            <CheckCircle2 className="size-7" />
          </div>
          <h1 className="mt-4 font-display text-xl font-semibold">Horário confirmado!</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDate(resultado.data)} às {horario} — {pagina.salao.nome}
          </p>
          <ul className="mt-4 space-y-1.5 text-left text-sm">
            {resultado.servicos.map((s) => (
              <li key={s.servico_id} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate">{s.nome}</span>
                <Money value={s.preco} />
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted-foreground">
            Guarde a data — o salão já foi avisado do seu agendamento.
          </p>
        </Card>
      </div>
    );
  }

  const podeAvancarEtapa1 = clienteNome.trim().length > 0 && telefoneValido(clienteTelefone);
  const podeAvancarEtapa2 = Boolean(horario);

  return (
    <div className="mx-auto min-h-screen max-w-lg px-5 py-8 pb-10">
      <section className="mb-6 overflow-hidden rounded-2xl border border-border bg-surface shadow-soft">
        <div className="flex items-center gap-3 p-4">
          {pagina.salao.foto_url ? (
            <img
              src={pagina.salao.foto_url}
              alt={`Foto de ${pagina.salao.nome}`}
              className="size-14 shrink-0 rounded-2xl border border-primary-mid/50 object-cover"
            />
          ) : (
            <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-brand-gradient text-primary-foreground shadow-glow">
              <Sparkles className="size-6" />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="truncate font-display text-lg font-semibold">{pagina.salao.nome}</h1>
            <p className="text-xs text-muted-foreground">Agendar horário online</p>
            {pagina.salao.descricao_publica ? (
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                {pagina.salao.descricao_publica}
              </p>
            ) : null}
          </div>
        </div>

        {whatsapp || instagram || mapa ? (
          <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
            {whatsapp ? (
              <Button asChild size="sm" variant="outline">
                <a href={whatsapp} target="_blank" rel="noreferrer">
                  <MessageCircle className="size-4" />
                  WhatsApp
                </a>
              </Button>
            ) : null}
            {instagram ? (
              <Button asChild size="sm" variant="outline">
                <a href={instagram} target="_blank" rel="noreferrer">
                  <Instagram className="size-4" />
                  Instagram
                </a>
              </Button>
            ) : null}
            {mapa ? (
              <Button asChild size="sm" variant="outline">
                <a href={mapa} target="_blank" rel="noreferrer">
                  <MapPin className="size-4" />
                  Como chegar
                </a>
              </Button>
            ) : null}
          </div>
        ) : null}

        {(pagina.salao.horarios ?? []).length ? (
          <details className="border-t border-border px-4 py-3">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
              <Clock className="size-4 text-primary" />
              Ver expediente
            </summary>
            <ul className="mt-3 space-y-1.5 text-xs text-muted-foreground">
              {(pagina.salao.horarios ?? []).map((dia) => {
                const primeiroTurno = mostrarHorario(dia.hora_inicio, dia.hora_fim);
                const segundoTurno = mostrarHorario(dia.hora_inicio_2, dia.hora_fim_2);
                return (
                  <li key={dia.dia_semana} className="flex items-center justify-between gap-3">
                    <span className="font-medium text-foreground">
                      {DIAS_SEMANA[dia.dia_semana]}
                    </span>
                    <span>
                      {dia.ativo && primeiroTurno
                        ? [primeiroTurno, segundoTurno].filter(Boolean).join(" · ")
                        : "Fechado"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </details>
        ) : null}
      </section>

      <EtapasIndicador atual={etapa} />

      {/* `key={etapa}` força a remontagem, o que dispara a animação de entrada
          a cada troca de etapa — sem precisar de biblioteca de animação. */}
      <div
        key={etapa}
        className={cn(
          "animate-in fade-in duration-300",
          direcao === "avancar" ? "slide-in-from-right-8" : "slide-in-from-left-8",
        )}
      >
        {etapa === 1 ? (
          <div>
            <SectionTitle hint="Pra confirmar com você e avisar do horário">
              Seus dados
            </SectionTitle>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="nome-cliente">Nome</Label>
                <Input
                  id="nome-cliente"
                  value={clienteNome}
                  onChange={(e) => setClienteNome(e.target.value)}
                  className="h-11 rounded-xl"
                  maxLength={80}
                  autoFocus
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="telefone-cliente">WhatsApp</Label>
                <Input
                  id="telefone-cliente"
                  value={clienteTelefone}
                  onChange={(e) => setClienteTelefone(formatTelefone(e.target.value))}
                  placeholder="(00) 00000-0000"
                  className="h-11 rounded-xl"
                  inputMode="numeric"
                  maxLength={15}
                  required
                />
              </div>
            </div>

            <Button
              className="mt-6 h-12 w-full rounded-xl text-base"
              onClick={() => irPara(2)}
              disabled={!podeAvancarEtapa1}
            >
              Continuar
              <ArrowRight className="size-4" />
            </Button>
          </div>
        ) : null}

        {etapa === 2 ? (
          <div>
            <button
              type="button"
              onClick={() => irPara(1)}
              className="mb-4 flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-left"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{clienteNome}</span>
                <span className="text-xs text-muted-foreground">{clienteTelefone}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-primary">
                <Pencil className="size-3" />
                Editar
              </span>
            </button>

            <SectionTitle hint="Selecione um ou mais">Serviços</SectionTitle>
            {servicos.length ? (
              <div className="space-y-4">
                {servicosPorCategoria.map(([categoria, servicosDaCategoria]) => (
                  <section key={categoria} aria-label={`Categoria ${categoria}`}>
                    <h3 className="mb-2 text-sm font-semibold text-primary-dark">{categoria}</h3>
                    <ul className="space-y-2">
                      {servicosDaCategoria.map((s) => (
                        <li key={s.id}>
                          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3">
                            <span className="flex min-w-0 items-center gap-2.5">
                              <Checkbox
                                checked={servicoIds.includes(s.id)}
                                onCheckedChange={() => alternarServico(s.id)}
                              />
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-medium">{s.nome}</span>
                                <span className="text-xs text-muted-foreground">
                                  {s.duracao_minutos} min
                                </span>
                              </span>
                            </span>
                            <Money value={s.preco} className="shrink-0" />
                          </label>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<Scissors className="size-5" />}
                titulo="Nenhum serviço disponível"
                descricao="O salão ainda não cadastrou serviços para agendamento online."
              />
            )}

            {servicoIds.length > 0 ? (
              <div className="mt-6 animate-in fade-in duration-300">
                <SectionTitle hint="Só aparecem horários realmente livres">
                  Data e horário
                </SectionTitle>
                <div className="space-y-1.5">
                  <Label htmlFor="data-agendamento">Data</Label>
                  <Input
                    id="data-agendamento"
                    type="date"
                    min={hojeISO()}
                    value={data}
                    onChange={(e) => {
                      setData(e.target.value);
                      setHorario(null);
                    }}
                    className="h-11 rounded-xl"
                  />
                </div>

                <div className="mt-3">
                  {buscandoHorarios ? (
                    <ListSkeleton linhas={1} />
                  ) : disponibilidade?.horarios.length ? (
                    <div className="flex flex-wrap gap-2">
                      {disponibilidade.horarios.map((h) => (
                        <button
                          key={h}
                          type="button"
                          onClick={() => setHorario(h)}
                          className="focus-visible:outline-none"
                        >
                          <Pill
                            tone="neutral"
                            className={cn(
                              "cursor-pointer px-3 py-2 text-sm",
                              horario === h && "bg-primary text-primary-foreground",
                            )}
                          >
                            <Clock className="size-3.5" />
                            {h}
                          </Pill>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-xl border border-dashed border-border px-3 py-3 text-center text-sm text-muted-foreground">
                      Nenhum horário livre nesse dia. Tente outra data.
                    </p>
                  )}
                </div>
              </div>
            ) : null}

            <div className="mt-6 flex gap-3">
              <Button variant="outline" className="h-12 rounded-xl px-4" onClick={() => irPara(1)}>
                <ArrowLeft className="size-4" />
              </Button>
              <Button
                className="h-12 flex-1 rounded-xl text-base"
                onClick={() => irPara(3)}
                disabled={!podeAvancarEtapa2}
              >
                Continuar
                <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        ) : null}

        {etapa === 3 ? (
          <div>
            <SectionTitle hint="Confira antes de confirmar">Resumo</SectionTitle>

            <div className="space-y-3">
              <button
                type="button"
                onClick={() => irPara(1)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3 text-left"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{clienteNome}</span>
                  <span className="text-xs text-muted-foreground">{clienteTelefone}</span>
                </span>
                <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
              </button>

              <button
                type="button"
                onClick={() => irPara(2)}
                className="w-full rounded-xl border border-border bg-surface p-3 text-left"
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">
                    {formatDate(data)} às {horario}
                  </span>
                  <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
                </div>
                <ul className="space-y-1">
                  {servicosEscolhidos.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate text-muted-foreground">{s.nome}</span>
                      <Money value={s.preco} />
                    </li>
                  ))}
                </ul>
              </button>

              <Card tone="brand" className="p-4">
                <div className="flex items-center justify-between gap-3 text-sm font-semibold">
                  <span>Total</span>
                  <Money value={precoTotal} className="text-primary-foreground" />
                </div>
              </Card>
            </div>

            {agendar.isError ? (
              <p
                role="alert"
                className="mt-3 rounded-xl border border-negative-mid/60 bg-negative-soft px-3 py-2.5 text-sm text-negative"
              >
                {textoDoErro(agendar.error)}
              </p>
            ) : null}

            <div className="mt-6 flex gap-3">
              <Button
                variant="outline"
                className="h-12 rounded-xl px-4"
                onClick={() => irPara(2)}
                disabled={agendar.isPending}
              >
                <ArrowLeft className="size-4" />
              </Button>
              <Button
                className="h-12 flex-1 rounded-xl text-base"
                onClick={confirmar}
                disabled={agendar.isPending}
              >
                <CalendarCheck className="size-4" />
                Confirmar agendamento
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
