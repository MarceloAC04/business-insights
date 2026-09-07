import { CalendarClock, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  Card,
  EmptyState,
  ListSkeleton,
  Pill,
  SectionTitle,
} from "@/components/ui-kit";
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
import { Switch } from "@/components/ui/switch";
import { formatBRL, formatMoedaInput, nomeMes, parseMoedaInput } from "@/lib/format";
import {
  textoDoErro,
  useCriarCustoFixo,
  useCustosFixos,
  useExcluirCustoFixo,
  usePagarCustoFixo,
} from "@/lib/queries";
import type { CustoFixo } from "@/lib/types";

function competenciaAtual(): string {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
}

export function CustosFixosScreen() {
  const competencia = competenciaAtual();
  const { data: custos, isPending: carregandoCustos } = useCustosFixos(competencia);
  const criarCusto = useCriarCustoFixo();
  const excluirCusto = useExcluirCustoFixo();
  const pagarCusto = usePagarCustoFixo();

  const [custoAberto, setCustoAberto] = useState(false);
  const [formCusto, setFormCusto] = useState({ descricao: "", valor: "", dia: "5" });
  const [custoParaExcluir, setCustoParaExcluir] = useState<CustoFixo | null>(null);

  const cadastrarCusto = () => {
    const valor = parseMoedaInput(formCusto.valor);
    const dia = Number(formCusto.dia);
    if (!formCusto.descricao.trim() || !(valor > 0) || !(dia >= 1 && dia <= 31)) {
      toast.error("Informe descrição, valor e um dia de vencimento entre 1 e 31.");
      return;
    }
    criarCusto.mutate(
      { descricao: formCusto.descricao.trim(), valor, dia_vencimento: dia },
      {
        onSuccess: () => {
          setCustoAberto(false);
          setFormCusto({ descricao: "", valor: "", dia: "5" });
          toast.success("Custo fixo cadastrado.");
        },
        onError: (erro) => toast.error(textoDoErro(erro)),
      },
    );
  };

  const alternarPagamento = (custo: CustoFixo) => {
    pagarCusto.mutate({ id: custo.id, competencia, pago: !custo.pago }, {
      onSuccess: () =>
        toast.success(custo.pago ? "Pagamento desmarcado." : `${custo.descricao} marcado como pago.`),
      onError: (erro) => toast.error(textoDoErro(erro)),
    });
  };

  const confirmarExclusao = () => {
    if (!custoParaExcluir) return;
    excluirCusto.mutate(custoParaExcluir.id, {
      onSuccess: () => {
        setCustoParaExcluir(null);
        toast.success("Custo fixo excluído.");
      },
      onError: (erro) => toast.error(textoDoErro(erro)),
    });
  };

  return (
    <>
      <section>
        <SectionTitle
          hint="Cadastro recorrente: o mesmo aluguel vale para todo mês"
          action={
            <Button size="sm" onClick={() => setCustoAberto(true)}>
              <Plus className="size-4" />
              Novo
            </Button>
          }
        >
          Custos fixos de {nomeMes(Number(competencia.slice(5)))}
        </SectionTitle>
        {carregandoCustos ? (
          <ListSkeleton />
        ) : custos?.custos.length ? (
          <ul className="space-y-3">
            {custos.custos.map((custo) => (
              <li key={custo.id}>
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{custo.descricao}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">todo dia {custo.dia_vencimento}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Pill tone="brand">{formatBRL(custo.valor)}</Pill>
                        <Pill tone={custo.pago ? "positive" : "warning"}>
                          {custo.pago ? "Pago" : "Pendente"}
                        </Pill>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Pago</span>
                        <Switch
                          checked={custo.pago}
                          onCheckedChange={() => alternarPagamento(custo)}
                          disabled={pagarCusto.isPending}
                          aria-label={`Marcar ${custo.descricao} como pago`}
                        />
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Excluir custo fixo"
                        onClick={() => setCustoParaExcluir(custo)}
                      >
                        <Trash2 className="size-4 text-negative" />
                      </Button>
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<CalendarClock className="size-5" />}
            titulo="Nenhum custo fixo cadastrado"
            descricao="Aluguel, energia e internet entram aqui uma vez e voltam todo mês."
            acao={<Button onClick={() => setCustoAberto(true)}>Novo custo fixo</Button>}
          />
        )}
      </section>

      <Dialog open={custoAberto} onOpenChange={setCustoAberto}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Novo custo fixo</DialogTitle>
            <DialogDescription>
              Vale para todo mês. O dia é literal: "todo dia 31" continua 31 em fevereiro.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="desc-custo">Descrição</Label>
              <Input
                id="desc-custo"
                value={formCusto.descricao}
                onChange={(e) => setFormCusto({ ...formCusto, descricao: e.target.value })}
                placeholder="Ex.: aluguel da sala"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="valor-custo">Valor (R$)</Label>
                <Input
                  id="valor-custo"
                  inputMode="decimal"
                  value={formCusto.valor}
                  onChange={(e) => setFormCusto({ ...formCusto, valor: formatMoedaInput(e.target.value) })}
                  placeholder="0,00"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dia-custo">Dia do vencimento</Label>
                <Input
                  id="dia-custo"
                  inputMode="numeric"
                  value={formCusto.dia}
                  onChange={(e) => setFormCusto({ ...formCusto, dia: e.target.value })}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCustoAberto(false)} disabled={criarCusto.isPending}>
              Cancelar
            </Button>
            <Button onClick={cadastrarCusto} disabled={criarCusto.isPending}>
              Cadastrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={custoParaExcluir !== null} onOpenChange={(aberto) => !aberto && setCustoParaExcluir(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-negative" />
              Excluir custo fixo
            </AlertDialogTitle>
            <AlertDialogDescription>
              {custoParaExcluir?.descricao} deixa de entrar no cálculo dos próximos meses. Os meses já fechados não mudam.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={excluirCusto.isPending}>Voltar</AlertDialogCancel>
            <AlertDialogAction
              disabled={excluirCusto.isPending}
              onClick={(evento) => {
                evento.preventDefault();
                confirmarExclusao();
              }}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
