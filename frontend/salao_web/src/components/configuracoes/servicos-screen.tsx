import { Pencil, Plus, Scissors, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Card, EmptyState, ListSkeleton, Money, Pill, SectionTitle } from "@/components/ui-kit";
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
import { formatBRL, formatMoedaInput, parseMoedaInput } from "@/lib/format";
import {
  textoDoErro,
  useCriarServico,
  useEditarServico,
  useEstoque,
  useExcluirServico,
  useServicos,
} from "@/lib/queries";
import type { Servico } from "@/lib/types";

interface FormServico {
  id?: string;
  nome: string;
  preco: string;
  duracao: string;
  produtos: { item_estoque_id: string; quantidade: number }[];
}

export function ServicosScreen() {
  const { data: listaServicos, isPending: carregandoServicos } = useServicos();
  const { data: estoque } = useEstoque();
  const criarServico = useCriarServico();
  const editarServico = useEditarServico();
  const excluirServico = useExcluirServico();

  const [aberto, setAberto] = useState(false);
  const [form, setForm] = useState<FormServico>({ nome: "", preco: "", duracao: "", produtos: [] });
  const [servicoParaExcluir, setServicoParaExcluir] = useState<Servico | null>(null);

  const itens = estoque?.itens ?? [];
  const servicos = listaServicos?.servicos ?? [];
  const salvando = criarServico.isPending || editarServico.isPending;

  /** Prévia local pelo custo médio de hoje; o custo real fica congelado ao finalizar. */
  const custoInsumos = (produtos: FormServico["produtos"]) =>
    produtos.reduce((total, produto) => {
      const item = itens.find((atual) => atual.id === produto.item_estoque_id);
      return total + (item ? item.custo_medio * produto.quantidade : 0);
    }, 0);

  const abrirNovoServico = () => {
    setForm({ nome: "", preco: "", duracao: "", produtos: [] });
    setAberto(true);
  };

  const abrirEdicao = (servico: Servico) => {
    setForm({
      id: servico.id,
      nome: servico.nome,
      preco: formatMoedaInput(String(Math.round(servico.preco * 100))),
      duracao: servico.duracao_minutos ? String(servico.duracao_minutos) : "",
      produtos: servico.produtos_padrao.map((produto) => ({
        item_estoque_id: produto.item_estoque_id,
        quantidade: produto.quantidade,
      })),
    });
    setAberto(true);
  };

  const salvarServico = () => {
    const preco = parseMoedaInput(form.preco);
    const duracao_minutos = Number(form.duracao);
    if (!form.nome.trim() || !(preco > 0)) {
      toast.error("Informe o nome do serviço e um preço válido.");
      return;
    }
    if (!(duracao_minutos > 0)) {
      toast.error("Informe a duração do serviço em minutos.");
      return;
    }

    const body = {
      nome: form.nome.trim(),
      preco,
      duracao_minutos,
      produtos_padrao: form.produtos,
    };
    const finalizado = {
      onSuccess: () => {
        setAberto(false);
        toast.success(form.id ? "Serviço atualizado." : "Serviço cadastrado.");
      },
      onError: (erro: unknown) => toast.error(textoDoErro(erro)),
    };

    if (form.id) editarServico.mutate({ id: form.id, body }, finalizado);
    else criarServico.mutate(body, finalizado);
  };

  const alternarInsumo = (itemId: string) => {
    const existe = form.produtos.some((produto) => produto.item_estoque_id === itemId);
    setForm({
      ...form,
      produtos: existe
        ? form.produtos.filter((produto) => produto.item_estoque_id !== itemId)
        : [...form.produtos, { item_estoque_id: itemId, quantidade: 1 }],
    });
  };

  const confirmarExclusao = () => {
    if (!servicoParaExcluir) return;
    excluirServico.mutate(servicoParaExcluir.id, {
      onSuccess: () => {
        setServicoParaExcluir(null);
        toast.success("Serviço excluído.");
      },
      onError: (erro) => toast.error(textoDoErro(erro)),
    });
  };

  return (
    <>
      <section>
        <SectionTitle
          hint="Os insumos padrão já vêm preenchidos ao finalizar um atendimento"
          action={
            <Button size="sm" onClick={abrirNovoServico}>
              <Plus className="size-4" />
              Novo
            </Button>
          }
        >
          Serviços
        </SectionTitle>
        {carregandoServicos ? (
          <ListSkeleton />
        ) : servicos.length ? (
          <ul className="space-y-3">
            {servicos.map((servico) => {
              const custo = custoInsumos(
                servico.produtos_padrao.map((produto) => ({
                  item_estoque_id: produto.item_estoque_id,
                  quantidade: produto.quantidade,
                })),
              );

              return (
                <li key={servico.id}>
                  <Card className="p-4">
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{servico.nome}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {servico.produtos_padrao.length
                            ? servico.produtos_padrao
                                .map((produto) => `${produto.quantidade}${produto.unidade} ${produto.nome}`)
                                .join(", ")
                            : "sem insumos padrão"}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <Pill tone="brand">Preço {formatBRL(servico.preco)}</Pill>
                          <Pill>Custo {formatBRL(custo)}</Pill>
                          <Pill tone={servico.preco - custo >= 0 ? "positive" : "negative"}>
                            Lucro {formatBRL(servico.preco - custo)}
                          </Pill>
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button size="icon" variant="ghost" aria-label="Editar serviço" onClick={() => abrirEdicao(servico)}>
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Excluir serviço"
                          onClick={() => setServicoParaExcluir(servico)}
                        >
                          <Trash2 className="size-4 text-negative" />
                        </Button>
                      </div>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            icon={<Scissors className="size-5" />}
            titulo="Nenhum serviço cadastrado"
            descricao="A tabela de preços alimenta o agendamento e o lucro por serviço."
            acao={<Button onClick={abrirNovoServico}>Novo serviço</Button>}
          />
        )}
      </section>

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{form.id ? "Editar serviço" : "Novo serviço"}</DialogTitle>
            <DialogDescription>
              Escolha os insumos padrão: eles já vêm preenchidos ao finalizar um atendimento.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="nome-servico">Nome do serviço</Label>
              <Input
                id="nome-servico"
                value={form.nome}
                onChange={(evento) => setForm({ ...form, nome: evento.target.value })}
                placeholder="Ex.: extensão de cílios"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="preco-servico">Preço (R$)</Label>
                <Input
                  id="preco-servico"
                  inputMode="decimal"
                  value={form.preco}
                  onChange={(evento) => setForm({ ...form, preco: formatMoedaInput(evento.target.value) })}
                  placeholder="0,00"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="duracao-servico">Duração (min)</Label>
                <Input
                  id="duracao-servico"
                  inputMode="numeric"
                  value={form.duracao}
                  onChange={(evento) =>
                    setForm({ ...form, duracao: evento.target.value.replace(/\D/g, "") })
                  }
                  placeholder="Ex.: 60"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Insumos padrão</Label>
              <div className="max-h-52 space-y-1.5 overflow-y-auto rounded-xl border border-border p-2">
                {itens.map((itemEstoque) => {
                  const item = form.produtos.find((produto) => produto.item_estoque_id === itemEstoque.id);
                  return (
                    <div key={itemEstoque.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
                      <Checkbox
                        checked={item !== undefined}
                        onCheckedChange={() => alternarInsumo(itemEstoque.id)}
                        aria-label={itemEstoque.nome}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">{itemEstoque.nome}</span>
                      {item ? (
                        <Input
                          className="h-9 w-16"
                          inputMode="numeric"
                          value={String(item.quantidade)}
                          onChange={(evento) =>
                            setForm({
                              ...form,
                              produtos: form.produtos.map((produto) =>
                                produto.item_estoque_id === itemEstoque.id
                                  ? { ...produto, quantidade: Number(evento.target.value) || 1 }
                                  : produto,
                              ),
                            })
                          }
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">{itemEstoque.unidade}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Custo estimado pelo custo médio de hoje: <Money value={custoInsumos(form.produtos)} />
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAberto(false)} disabled={salvando}>
              Cancelar
            </Button>
            <Button onClick={salvarServico} disabled={salvando}>
              <Scissors className="size-4" />
              Salvar serviço
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={servicoParaExcluir !== null} onOpenChange={(aberto) => !aberto && setServicoParaExcluir(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-negative" />
              Excluir serviço
            </AlertDialogTitle>
            <AlertDialogDescription>
              {servicoParaExcluir?.nome} deixa de aparecer na tabela e no agendamento. Atendimentos passados não mudam.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={excluirServico.isPending}>Voltar</AlertDialogCancel>
            <AlertDialogAction
              disabled={excluirServico.isPending}
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
