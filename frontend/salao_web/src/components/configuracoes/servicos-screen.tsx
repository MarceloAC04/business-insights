import { Loader2, Pencil, Plus, Scissors, Search, Trash2, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatBRL, formatMoedaInput, parseMoedaInput } from "@/lib/format";
import {
  textoDoErro,
  useCategoriasServico,
  useCriarCategoriaServico,
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
  categoria: string;
  preco: string;
  duracao: string;
  produtos: { item_estoque_id: string; quantidade: number }[];
}

export function ServicosScreen() {
  const { data: listaServicos, isPending: carregandoServicos } = useServicos();
  const { data: listaCategorias, isPending: carregandoCategorias } = useCategoriasServico();
  const { data: estoque } = useEstoque();
  const criarServico = useCriarServico();
  const editarServico = useEditarServico();
  const excluirServico = useExcluirServico();
  const criarCategoria = useCriarCategoriaServico();

  const [aberto, setAberto] = useState(false);
  const [form, setForm] = useState<FormServico>({
    nome: "",
    categoria: "",
    preco: "",
    duracao: "",
    produtos: [],
  });
  const [servicoParaExcluir, setServicoParaExcluir] = useState<Servico | null>(null);
  const [buscaServico, setBuscaServico] = useState("");
  const [buscaInsumo, setBuscaInsumo] = useState("");
  const [dialogCategoriaAberto, setDialogCategoriaAberto] = useState(false);
  const [novaCategoria, setNovaCategoria] = useState("");

  const itens = useMemo(() => estoque?.itens ?? [], [estoque?.itens]);
  const servicos = useMemo(() => listaServicos?.servicos ?? [], [listaServicos?.servicos]);
  const salvando = criarServico.isPending || editarServico.isPending;
  const servicosFiltrados = useMemo(() => {
    const busca = buscaServico.trim().toLocaleLowerCase("pt-BR");
    return busca
      ? servicos.filter((servico) => servico.nome.toLocaleLowerCase("pt-BR").includes(busca))
      : servicos;
  }, [buscaServico, servicos]);
  const insumosFiltrados = useMemo(() => {
    const busca = buscaInsumo.trim().toLocaleLowerCase("pt-BR");
    return busca
      ? itens.filter((item) => item.nome.toLocaleLowerCase("pt-BR").includes(busca))
      : itens;
  }, [buscaInsumo, itens]);
  const categorias = listaCategorias?.categorias ?? [];

  /** Prévia local pelo custo médio de hoje; o custo real fica congelado ao finalizar. */
  const custoInsumos = (produtos: FormServico["produtos"]) =>
    produtos.reduce((total, produto) => {
      const item = itens.find((atual) => atual.id === produto.item_estoque_id);
      return total + (item ? (item.custo_por_uso ?? item.custo_medio) * produto.quantidade : 0);
    }, 0);

  const abrirNovoServico = () => {
    setForm({ nome: "", categoria: "", preco: "", duracao: "", produtos: [] });
    setBuscaInsumo("");
    setAberto(true);
  };

  const abrirEdicao = (servico: Servico) => {
    setForm({
      id: servico.id,
      nome: servico.nome,
      categoria: servico.categoria ?? "Outros",
      preco: formatMoedaInput(String(Math.round(servico.preco * 100))),
      duracao: servico.duracao_minutos ? String(servico.duracao_minutos) : "",
      produtos: servico.produtos_padrao.map((produto) => ({
        item_estoque_id: produto.item_estoque_id,
        quantidade: produto.quantidade,
      })),
    });
    setBuscaInsumo("");
    setAberto(true);
  };

  const salvarServico = () => {
    const preco = parseMoedaInput(form.preco);
    const duracao_minutos = Number(form.duracao);
    if (!form.nome.trim() || !form.categoria.trim() || !(preco > 0)) {
      toast.error("Informe o nome, a categoria e um preço válido.");
      return;
    }
    if (!(duracao_minutos > 0)) {
      toast.error("Informe a duração do serviço em minutos.");
      return;
    }

    const body = {
      nome: form.nome.trim(),
      categoria: form.categoria.trim(),
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

  const abrirNovaCategoria = () => {
    setNovaCategoria("");
    setDialogCategoriaAberto(true);
  };

  const salvarCategoria = () => {
    const nome = novaCategoria.trim();
    if (!nome) {
      toast.error("Informe o nome da categoria.");
      return;
    }
    criarCategoria.mutate(
      { nome },
      {
        onSuccess: (categoria) => {
          setForm((atual) => ({ ...atual, categoria: categoria.nome }));
          setDialogCategoriaAberto(false);
          toast.success("Categoria cadastrada.");
        },
        onError: (erro) => toast.error(textoDoErro(erro)),
      },
    );
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
        {servicos.length ? (
          <div className="relative mb-4">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={buscaServico}
              onChange={(evento) => setBuscaServico(evento.target.value)}
              className="pl-9"
              placeholder="Buscar serviço por nome"
              aria-label="Buscar serviço por nome"
            />
          </div>
        ) : null}
        {carregandoServicos ? (
          <ListSkeleton />
        ) : servicosFiltrados.length ? (
          <ul className="space-y-3">
            {servicosFiltrados.map((servico) => {
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
                                .map(
                                  (produto) =>
                                    `${produto.quantidade} ${produto.unidade_consumo} ${produto.nome}`,
                                )
                                .join(", ")
                            : "sem insumos padrão"}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <Pill tone="brand">{servico.categoria || "Outros"}</Pill>
                          <Pill tone="brand">Preço {formatBRL(servico.preco)}</Pill>
                          <Pill>Custo {formatBRL(custo)}</Pill>
                          <Pill tone={servico.preco - custo >= 0 ? "positive" : "negative"}>
                            Lucro {formatBRL(servico.preco - custo)}
                          </Pill>
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Editar serviço"
                          onClick={() => abrirEdicao(servico)}
                        >
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
            titulo={servicos.length ? "Nenhum serviço encontrado" : "Nenhum serviço cadastrado"}
            descricao={
              servicos.length
                ? "Tente ajustar a busca para encontrar o serviço."
                : "A tabela de preços alimenta o agendamento e o lucro por serviço."
            }
            acao={
              servicos.length ? (
                <Button variant="outline" onClick={() => setBuscaServico("")}>
                  Limpar busca
                </Button>
              ) : (
                <Button onClick={abrirNovoServico}>Novo serviço</Button>
              )
            }
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
            <div className="space-y-1.5">
              <Label htmlFor="categoria-servico">Categoria</Label>
              <div className="flex gap-2">
                <Select
                  value={form.categoria}
                  onValueChange={(categoria) => setForm({ ...form, categoria })}
                  disabled={carregandoCategorias || categorias.length === 0}
                >
                  <SelectTrigger id="categoria-servico" className="flex-1">
                    <SelectValue
                      placeholder={
                        carregandoCategorias
                          ? "Carregando categorias..."
                          : "Selecione uma categoria"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {categorias.map((categoria) => (
                      <SelectItem key={categoria.id} value={categoria.nome}>
                        {categoria.nome}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={abrirNovaCategoria}
                  aria-label="Adicionar nova categoria"
                >
                  <Plus className="size-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                O seletor mostra apenas categorias cadastradas. Use + para adicionar uma nova.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="preco-servico">Preço (R$)</Label>
                <Input
                  id="preco-servico"
                  inputMode="decimal"
                  value={form.preco}
                  onChange={(evento) =>
                    setForm({ ...form, preco: formatMoedaInput(evento.target.value) })
                  }
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
              <div>
                <Label>Insumos padrão por atendimento</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  Em produtos por usos, informe quantos usos o atendimento consome. Nos demais,
                  informe a quantidade física.
                </p>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={buscaInsumo}
                  onChange={(evento) => setBuscaInsumo(evento.target.value)}
                  className="pl-9"
                  placeholder="Buscar produto por nome"
                  aria-label="Buscar insumo por nome"
                />
              </div>
              <div className="max-h-52 space-y-1.5 overflow-y-auto rounded-xl border border-border p-2">
                {insumosFiltrados.map((itemEstoque) => {
                  const item = form.produtos.find(
                    (produto) => produto.item_estoque_id === itemEstoque.id,
                  );
                  const rotuloConsumo =
                    itemEstoque.modo_controle === "rendimento_usos"
                      ? "uso(s) por atendimento"
                      : `${itemEstoque.unidade} por atendimento`;
                  return (
                    <div
                      key={itemEstoque.id}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5"
                    >
                      <Checkbox
                        checked={item !== undefined}
                        onCheckedChange={() => alternarInsumo(itemEstoque.id)}
                        aria-label={itemEstoque.nome}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{itemEstoque.nome}</span>
                        <span className="block text-xs text-muted-foreground">{rotuloConsumo}</span>
                      </span>
                      {item ? (
                        <div className="flex shrink-0 items-center gap-1">
                          <Input
                            className="h-9 w-16"
                            inputMode="decimal"
                            value={String(item.quantidade)}
                            aria-label={`Quantidade de ${itemEstoque.nome} em ${rotuloConsumo}`}
                            onChange={(evento) =>
                              setForm({
                                ...form,
                                produtos: form.produtos.map((produto) =>
                                  produto.item_estoque_id === itemEstoque.id
                                    ? {
                                        ...produto,
                                        quantidade:
                                          Number(evento.target.value.replace(",", ".")) || 1,
                                      }
                                    : produto,
                                ),
                              })
                            }
                          />
                          <span className="text-xs text-muted-foreground">
                            {itemEstoque.modo_controle === "rendimento_usos"
                              ? "usos"
                              : itemEstoque.unidade}
                          </span>
                        </div>
                      ) : (
                        <Pill
                          tone={
                            itemEstoque.modo_controle === "rendimento_usos" ? "brand" : "neutral"
                          }
                        >
                          {itemEstoque.modo_controle === "rendimento_usos"
                            ? "Por uso"
                            : `Por ${itemEstoque.unidade}`}
                        </Pill>
                      )}
                    </div>
                  );
                })}
                {insumosFiltrados.length === 0 ? (
                  <p className="p-3 text-center text-sm text-muted-foreground">
                    Nenhum produto encontrado.
                  </p>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                Custo estimado pelo custo médio de hoje:{" "}
                <Money value={custoInsumos(form.produtos)} />
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

      <Dialog open={dialogCategoriaAberto} onOpenChange={setDialogCategoriaAberto}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Nova categoria</DialogTitle>
            <DialogDescription>
              Ela ficará disponível para selecionar nos seus serviços.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="nova-categoria">Nome da categoria</Label>
            <Input
              id="nova-categoria"
              value={novaCategoria}
              onChange={(evento) => setNovaCategoria(evento.target.value)}
              placeholder="Ex.: Sobrancelhas"
              maxLength={60}
              onKeyDown={(evento) => {
                if (evento.key === "Enter") {
                  evento.preventDefault();
                  salvarCategoria();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogCategoriaAberto(false)}
              disabled={criarCategoria.isPending}
            >
              Cancelar
            </Button>
            <Button onClick={salvarCategoria} disabled={criarCategoria.isPending}>
              {criarCategoria.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Adicionar categoria
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={servicoParaExcluir !== null}
        onOpenChange={(aberto) => !aberto && setServicoParaExcluir(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-negative" />
              Excluir serviço
            </AlertDialogTitle>
            <AlertDialogDescription>
              {servicoParaExcluir?.nome} deixa de aparecer na tabela e no agendamento. Atendimentos
              passados não mudam.
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
