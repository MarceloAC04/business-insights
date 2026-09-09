import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ImagePlus, Loader2, LogOut, Target } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { AgendamentoScreen, LinkAgendamentoCard } from "@/components/configuracoes/agendamento-screen";
import { CustosFixosScreen } from "@/components/configuracoes/custos-fixos-screen";
import { ServicosScreen } from "@/components/configuracoes/servicos-screen";
import { Card, ListSkeleton, SectionTitle, StatCard } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  formatBRL,
  formatMoedaInput,
  formatTelefone,
  nomeMes,
  parseMoedaInput,
} from "@/lib/format";
import {
  textoDoErro,
  useCustosFixos,
  useEnviarFotoPerfil,
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
  const enviarFoto = useEnviarFotoPerfil();
  const sair = useLogout();
  const campoFoto = useRef<HTMLInputElement>(null);
  const [perfil, setPerfil] = useState({
    nome: "",
    proprietaria: "",
    telefone: "",
    fotoUrl: "",
    instagram: "",
    endereco: "",
    descricao: "",
    meta: "",
  });
  const [secaoAtiva, setSecaoAtiva] = useState<SecaoPerfil>("dados");

  useEffect(() => {
    const salao = perfilServidor?.salao;
    if (!salao) return;
    setPerfil({
      nome: salao.nome,
      proprietaria: salao.proprietaria,
      telefone: formatTelefone(salao.telefone_whatsapp ?? ""),
      fotoUrl: salao.foto_url ?? "",
      instagram: salao.instagram_url ?? "",
      endereco: salao.endereco ?? "",
      descricao: salao.descricao_publica ?? "",
      meta: formatMoedaInput(String(Math.round(salao.meta_faturamento_mensal * 100))),
    });
  }, [perfilServidor]);

  const irParaSecao = (secao: SecaoPerfil) => {
    setSecaoAtiva(secao);
  };

  const selecionarFoto = (evento: React.ChangeEvent<HTMLInputElement>) => {
    const arquivo = evento.target.files?.[0];
    evento.target.value = "";
    if (!arquivo) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(arquivo.type)) {
      toast.error("Escolha uma imagem JPEG, PNG ou WebP.");
      return;
    }
    if (arquivo.size > 5 * 1024 * 1024) {
      toast.error("A imagem deve ter no máximo 5 MB.");
      return;
    }
    enviarFoto.mutate(arquivo, {
      onSuccess: ({ foto_url }) => {
        setPerfil((atual) => ({ ...atual, fotoUrl: foto_url }));
        toast.success("Foto carregada. Salve os dados para publicar a alteração.");
      },
      onError: (erro) => toast.error(textoDoErro(erro)),
    });
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
        foto_url: perfil.fotoUrl.trim() || null,
        instagram_url: perfil.instagram.trim(),
        endereco: perfil.endereco.trim(),
        descricao_publica: perfil.descricao.trim(),
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
        <StatCard
          label="Custos fixos"
          value={formatBRL(custos?.total_mensal ?? 0)}
          hint="por mês"
        />
        <StatCard
          label={`A pagar em ${nomeMes(Number(competencia.slice(5)))}`}
          value={formatBRL(custos?.total_pendente ?? 0)}
          tone={custos && custos.total_pendente > 0 ? "warning" : "positive"}
        />
        <StatCard label="Serviços" value={String(servicos.length)} />
      </div>

      <div className="mt-5">
        <LinkAgendamentoCard />
      </div>

      <div className="mt-5 space-y-6">
        <nav
          aria-label="Seções do perfil"
          className="sticky top-[68px] z-20 -mx-4 overflow-x-auto bg-background/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-5 lg:px-5"
        >
          <div
            role="tablist"
            className="inline-flex h-11 min-w-max items-center rounded-xl bg-muted p-1 text-muted-foreground"
          >
            {SECOES_PERFIL.map((secao) => (
              <button
                key={secao.id}
                type="button"
                role="tab"
                id={`aba-${secao.id}`}
                aria-controls={`painel-${secao.id}`}
                aria-selected={secaoAtiva === secao.id}
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

        {secaoAtiva === "dados" ? (
          <section id="painel-dados" role="tabpanel" aria-labelledby="aba-dados">
            <Card className="p-4 sm:p-5">
              <SectionTitle hint="Dados públicos que a cliente vê no link de agendamento">
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
                        onChange={(evento) =>
                          setPerfil({ ...perfil, proprietaria: evento.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="telefone">WhatsApp</Label>
                      <Input
                        id="telefone"
                        value={perfil.telefone}
                        onChange={(evento) =>
                          setPerfil({ ...perfil, telefone: formatTelefone(evento.target.value) })
                        }
                        placeholder="(00) 00000-0000"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="instagram">Instagram</Label>
                      <Input
                        id="instagram"
                        value={perfil.instagram}
                        onChange={(evento) =>
                          setPerfil({ ...perfil, instagram: evento.target.value })
                        }
                        placeholder="@thamiresbeauty ou https://instagram.com/..."
                      />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor="endereco">Endereço</Label>
                      <Input
                        id="endereco"
                        value={perfil.endereco}
                        onChange={(evento) =>
                          setPerfil({ ...perfil, endereco: evento.target.value })
                        }
                        placeholder="Rua, número, bairro e cidade"
                      />
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                      <Label htmlFor="foto-publica">Foto ou logo</Label>
                      <input
                        ref={campoFoto}
                        id="foto-publica"
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="sr-only"
                        onChange={selecionarFoto}
                      />
                      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3">
                        {perfil.fotoUrl ? (
                          <img
                            src={perfil.fotoUrl}
                            alt="Prévia da foto do salão"
                            className="size-14 rounded-xl border border-primary-mid/50 object-cover"
                          />
                        ) : (
                          <div className="flex size-14 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                            <ImagePlus className="size-5" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">Envie uma imagem do dispositivo</p>
                          <p className="text-xs text-muted-foreground">
                            JPEG, PNG ou WebP, até 5 MB.
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => campoFoto.current?.click()}
                          disabled={enviarFoto.isPending}
                        >
                          {enviarFoto.isPending ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <ImagePlus className="size-4" />
                          )}
                          {enviarFoto.isPending ? "Enviando..." : "Escolher arquivo"}
                        </Button>
                      </div>
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
                        onChange={(evento) =>
                          setPerfil({ ...perfil, meta: formatMoedaInput(evento.target.value) })
                        }
                        placeholder="0,00"
                      />
                    </div>
                  </div>
                  <div className="mt-4 space-y-1.5">
                    <Label htmlFor="descricao-publica">Apresentação para a cliente</Label>
                    <Textarea
                      id="descricao-publica"
                      value={perfil.descricao}
                      onChange={(evento) =>
                        setPerfil({ ...perfil, descricao: evento.target.value })
                      }
                      placeholder="Ex.: Especialista em cílios e sobrancelhas."
                      maxLength={500}
                    />
                    <p className="text-xs text-muted-foreground">
                      Aparece no topo do link de agendamento junto aos seus contatos.
                    </p>
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
        ) : null}

        {secaoAtiva === "custos" ? (
          <section id="painel-custos" role="tabpanel" aria-labelledby="aba-custos">
            <CustosFixosScreen />
          </section>
        ) : null}

        {secaoAtiva === "servicos" ? (
          <section id="painel-servicos" role="tabpanel" aria-labelledby="aba-servicos">
            <ServicosScreen />
          </section>
        ) : null}

        {secaoAtiva === "agendamento" ? (
          <section id="painel-agendamento" role="tabpanel" aria-labelledby="aba-agendamento">
            <AgendamentoScreen />
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
