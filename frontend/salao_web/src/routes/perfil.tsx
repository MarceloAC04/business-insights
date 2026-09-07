import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LogOut, Target } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { AgendamentoScreen } from "@/components/configuracoes/agendamento-screen";
import { CustosFixosScreen } from "@/components/configuracoes/custos-fixos-screen";
import { ServicosScreen } from "@/components/configuracoes/servicos-screen";
import { Card, ListSkeleton, SectionTitle, StatCard } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatBRL, formatMoedaInput, formatTelefone, nomeMes, parseMoedaInput } from "@/lib/format";
import {
  textoDoErro,
  useCustosFixos,
  useLogout,
  usePerfil,
  useSalvarPerfil,
  useServicos,
} from "@/lib/queries";
import { cn } from "@/lib/utils";

const SECOES_PERFIL = [
  { id: "dados", label: "Dados e meta" },
  { id: "custos", label: "Custos fixos" },
  { id: "servicos", label: "Serviços" },
  { id: "agendamento", label: "Agendamento online" },
] as const;

type SecaoPerfil = (typeof SECOES_PERFIL)[number]["id"];

function competenciaAtual(): string {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
}

export const Route = createFileRoute("/perfil")({
  head: () => ({
    meta: [
      { title: "Perfil e serviços — GlowApp" },
      {
        name: "description",
        content: "Dados do salão, meta, custos fixos, serviços e agendamento online.",
      },
      { property: "og:title", content: "Perfil e serviços — GlowApp" },
      {
        property: "og:description",
        content: "Configure meta, custos fixos, serviços e o agendamento do salão.",
      },
    ],
  }),
  component: PerfilPage,
});

function PerfilPage() {
  const navigate = useNavigate();
  const competencia = competenciaAtual();
  const { data: perfilServidor, isPending: carregandoPerfil } = usePerfil();
  const { data: custos } = useCustosFixos(competencia);
  const { data: listaServicos } = useServicos();
  const salvar = useSalvarPerfil();
  const sair = useLogout();
  const [perfil, setPerfil] = useState({ nome: "", proprietaria: "", telefone: "", meta: "" });
  const [secaoAtiva, setSecaoAtiva] = useState<SecaoPerfil>("dados");

  useEffect(() => {
    const salao = perfilServidor?.salao;
    if (!salao) return;
    setPerfil({
      nome: salao.nome,
      proprietaria: salao.proprietaria,
      telefone: formatTelefone(salao.telefone_whatsapp ?? ""),
      meta: formatMoedaInput(String(Math.round(salao.meta_faturamento_mensal * 100))),
    });
  }, [perfilServidor]);

  const irParaSecao = (secao: SecaoPerfil) => {
    setSecaoAtiva(secao);
    document.getElementById(secao)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const salvarDados = () => {
    const meta = parseMoedaInput(perfil.meta);
    if (!perfil.nome.trim() || !perfil.proprietaria.trim()) {
      toast.error("Informe o nome do salão e da profissional.");
      return;
    }
    salvar.mutate(
      {
        nome: perfil.nome.trim(),
        proprietaria: perfil.proprietaria.trim(),
        telefone_whatsapp: perfil.telefone.trim() || null,
        meta_faturamento_mensal: meta,
      },
      {
        onSuccess: () => toast.success("Dados salvos."),
        onError: (erro) => toast.error(textoDoErro(erro)),
      },
    );
  };

  const encerrarSessao = () => {
    sair.mutate(undefined, {
      onSettled: () => void navigate({ to: "/login", replace: true }),
    });
  };

  const meta = perfilServidor?.salao.meta_faturamento_mensal ?? 0;
  const servicos = listaServicos?.servicos ?? [];

  return (
    <AppShell titulo="Perfil" subtitulo="Dados do salão, custos fixos e serviços">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Meta de faturamento"
          value={formatBRL(meta)}
          icon={<Target className="size-4" />}
          destaque
        />
        <StatCard label="Custos fixos" value={formatBRL(custos?.total_mensal ?? 0)} hint="por mês" />
        <StatCard
          label={`A pagar em ${nomeMes(Number(competencia.slice(5)))}`}
          value={formatBRL(custos?.total_pendente ?? 0)}
          tone={custos && custos.total_pendente > 0 ? "warning" : "positive"}
        />
        <StatCard label="Serviços" value={String(servicos.length)} />
      </div>

      <div className="mt-5 space-y-6">
        <nav
          aria-label="Seções do perfil"
          className="sticky top-[68px] z-20 -mx-4 overflow-x-auto bg-background/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-5 lg:px-5"
        >
          <div className="inline-flex h-11 min-w-max items-center rounded-xl bg-muted p-1 text-muted-foreground">
            {SECOES_PERFIL.map((secao) => (
              <button
                key={secao.id}
                type="button"
                onClick={() => irParaSecao(secao.id)}
                className={cn(
                  "inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  secaoAtiva === secao.id
                    ? "bg-surface text-foreground shadow"
                    : "hover:bg-surface/60 hover:text-foreground",
                )}
              >
                {secao.label}
              </button>
            ))}
          </div>
        </nav>

        <section id="dados" className="scroll-mt-32">
          <Card className="p-4 sm:p-5">
            <SectionTitle hint="Esses dados aparecem no agendamento e são usados no resumo financeiro">
              Dados do salão
            </SectionTitle>
            {carregandoPerfil ? (
              <ListSkeleton linhas={3} />
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="salao">Nome do salão</Label>
                    <Input
                      id="salao"
                      value={perfil.nome}
                      onChange={(evento) => setPerfil({ ...perfil, nome: evento.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="profissional">Profissional</Label>
                    <Input
                      id="profissional"
                      value={perfil.proprietaria}
                      onChange={(evento) => setPerfil({ ...perfil, proprietaria: evento.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="telefone">WhatsApp</Label>
                    <Input
                      id="telefone"
                      value={perfil.telefone}
                      onChange={(evento) => setPerfil({ ...perfil, telefone: formatTelefone(evento.target.value) })}
                      placeholder="(00) 00000-0000"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="meta-fat" className="flex items-center gap-1.5">
                      <Target className="size-3.5 text-primary" />
                      Meta de faturamento mensal (R$)
                    </Label>
                    <Input
                      id="meta-fat"
                      inputMode="decimal"
                      value={perfil.meta}
                      onChange={(evento) => setPerfil({ ...perfil, meta: formatMoedaInput(evento.target.value) })}
                      placeholder="0,00"
                    />
                  </div>
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button onClick={salvarDados} disabled={salvar.isPending}>
                    Salvar alterações
                  </Button>
                  <Button variant="ghost" onClick={encerrarSessao} disabled={sair.isPending}>
                    <LogOut className="size-4" />
                    Sair da conta
                  </Button>
                </div>
              </>
            )}
          </Card>
        </section>

        <section id="custos" className="scroll-mt-32">
          <CustosFixosScreen />
        </section>

        <section id="servicos" className="scroll-mt-32">
          <ServicosScreen />
        </section>

        <section id="agendamento" className="scroll-mt-32">
          <AgendamentoScreen />
        </section>
      </div>
    </AppShell>
  );
}
