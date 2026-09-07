import { Check, Copy, Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, ListSkeleton, SectionTitle } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { textoDoErro, useHorarioFuncionamento, useLinkAgendamento, useSalvarHorarioFuncionamento } from "@/lib/queries";
import type { HorarioDia } from "@/lib/types";

/** domingo=0 … sábado=6, mesma convenção do backend. */
const DIAS_SEMANA = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

function horariosPadrao(): HorarioDia[] {
  return DIAS_SEMANA.map((_, dia_semana) => ({
    dia_semana,
    ativo: dia_semana >= 1 && dia_semana <= 5,
    hora_inicio: dia_semana >= 1 && dia_semana <= 5 ? "09:00" : null,
    hora_fim: dia_semana >= 1 && dia_semana <= 5 ? "19:00" : null,
  }));
}

export function AgendamentoScreen() {
  const { data: horarioServidor, isPending: carregandoHorario } = useHorarioFuncionamento();
  const { data: link, isPending: carregandoLink } = useLinkAgendamento();
  const salvarHorario = useSalvarHorarioFuncionamento();
  const [horarios, setHorarios] = useState<HorarioDia[]>(horariosPadrao());
  const [linkCopiado, setLinkCopiado] = useState(false);

  useEffect(() => {
    if (horarioServidor?.horarios.length) setHorarios(horarioServidor.horarios);
  }, [horarioServidor]);

  const alternarDia = (dia_semana: number) => {
    setHorarios((atual) =>
      atual.map((horario) =>
        horario.dia_semana === dia_semana
          ? {
              ...horario,
              ativo: !horario.ativo,
              hora_inicio: horario.ativo ? null : (horario.hora_inicio ?? "09:00"),
              hora_fim: horario.ativo ? null : (horario.hora_fim ?? "18:00"),
            }
          : horario,
      ),
    );
  };

  const alterarHorario = (dia_semana: number, campo: "hora_inicio" | "hora_fim", valor: string) => {
    setHorarios((atual) =>
      atual.map((horario) =>
        horario.dia_semana === dia_semana ? { ...horario, [campo]: valor } : horario,
      ),
    );
  };

  const salvarHorarios = () => {
    salvarHorario.mutate(horarios, {
      onSuccess: () => toast.success("Horário de funcionamento salvo."),
      onError: (erro) => toast.error(textoDoErro(erro)),
    });
  };

  const copiarLink = () => {
    if (!link) return;
    navigator.clipboard.writeText(link.url).then(() => {
      setLinkCopiado(true);
      setTimeout(() => setLinkCopiado(false), 2000);
    });
  };

  return (
    <section className="space-y-4">
      <Card className="p-4">
        <SectionTitle hint="Link fixo — não expira, envie uma vez só">
          Link para o cliente agendar
        </SectionTitle>
        {carregandoLink ? (
          <ListSkeleton linhas={1} />
        ) : link ? (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-2 p-3">
            <Link2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm">{link.url}</span>
            <Button size="sm" variant="outline" onClick={copiarLink}>
              {linkCopiado ? <Check className="size-4" /> : <Copy className="size-4" />}
              {linkCopiado ? "Copiado" : "Copiar"}
            </Button>
          </div>
        ) : null}
      </Card>

      <Card className="p-4">
        <SectionTitle hint="Só aparecem horários dentro do expediente de cada dia">
          Horário de funcionamento
        </SectionTitle>
        {carregandoHorario ? (
          <ListSkeleton linhas={3} />
        ) : (
          <>
            <ul className="space-y-2">
              {horarios.map((horario) => (
                <li
                  key={horario.dia_semana}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3"
                >
                  <div className="flex min-w-[7rem] items-center gap-2">
                    <Switch
                      checked={horario.ativo}
                      onCheckedChange={() => alternarDia(horario.dia_semana)}
                      aria-label={`Abrir ${DIAS_SEMANA[horario.dia_semana]}`}
                    />
                    <span className="text-sm font-medium">{DIAS_SEMANA[horario.dia_semana]}</span>
                  </div>
                  {horario.ativo ? (
                    <div className="flex items-center gap-2">
                      <Input
                        type="time"
                        value={horario.hora_inicio ?? ""}
                        onChange={(evento) => alterarHorario(horario.dia_semana, "hora_inicio", evento.target.value)}
                        className="h-9 w-28"
                      />
                      <span className="text-sm text-muted-foreground">às</span>
                      <Input
                        type="time"
                        value={horario.hora_fim ?? ""}
                        onChange={(evento) => alterarHorario(horario.dia_semana, "hora_fim", evento.target.value)}
                        className="h-9 w-28"
                      />
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">Fechado</span>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <Button onClick={salvarHorarios} disabled={salvarHorario.isPending}>
                Salvar horário
              </Button>
            </div>
          </>
        )}
      </Card>
    </section>
  );
}
