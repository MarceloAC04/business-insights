import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  ClipboardCheck,
  History,
  Package,
  PackagePlus,
  Pencil,
  Plus,
  ScanBarcode,
  Search,
  ShoppingBag,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { BarcodeScannerDialog } from "@/components/BarcodeScanner";
import { EstoqueInsuficienteDialog, faltantesDoErro } from "@/components/EstoqueInsuficienteDialog";
import {
  Card,
  EmptyState,
  ListSkeleton,
  Money,
  Pill,
  SectionTitle,
  StatCard,
  type BadgeTone,
} from "@/components/ui-kit";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBRL, formatDateTime, formatMoedaInput, parseMoedaInput } from "@/lib/format";
import { EstoqueApi } from "@/lib/api/estoque";
import {
  textoDoErro,
  useCriarItem,
  useCriarKit,
  useCriarMovimentacao,
  useEditarItem,
  useEstoque,
  useKits,
  useMontarKit,
  useMovimentacoes,
  useVenderKit,
} from "@/lib/queries";
import type {
  CategoriaEstoque,
  FaltanteEstoque,
  FormaPagamento,
  ItemEstoque,
  Kit,
  ModoControleEstoque,
  StatusEstoque,
  TipoMovimentacao,
  UnidadeEstoque,
} from "@/lib/types";

export const Route = createFileRoute("/estoque")({
  head: () => ({
    meta: [
      { title: "Estoque e kits — GlowApp" },
      {
        name: "description",
        content:
          "Acompanhe saldo, custo médio ponderado e monte kits para revenda usando os insumos do salão.",
      },
      { property: "og:title", content: "Estoque e kits — GlowApp" },
      {
        property: "og:description",
        content: "Saldo de produtos, entradas, saídas e kits prontos para vender.",
      },
    ],
  }),
  component: EstoquePage,
});

/** `negativo` é distinto de `critico`: "devo mais do que tenho" ≠ "acabou" (A5). */
const tomStatus: Record<StatusEstoque, BadgeTone> = {
  ok: "positive",
  alerta: "warning",
  critico: "negative",
  negativo: "negative",
};

const rotuloStatus: Record<StatusEstoque, string> = {
  ok: "Saldo ok",
  alerta: "Estoque baixo",
  critico: "Sem saldo",
  negativo: "Saldo negativo",
};

const UNIDADES: { valor: UnidadeEstoque; label: string }[] = [
  { valor: "un", label: "Unidade" },
  { valor: "ml", label: "Mililitro" },
  { valor: "g", label: "Grama" },
  { valor: "cx", label: "Caixa" },
];

const CATEGORIAS: { valor: CategoriaEstoque; label: string }[] = [
  { valor: "cilios", label: "Cílios" },
  { valor: "sobrancelha", label: "Sobrancelhas" },
  { valor: "limpeza_pele", label: "Limpeza de pele" },
  { valor: "micropigmentacao", label: "Micropigmentação" },
  { valor: "reconstrucao", label: "Protocolos de reconstrução" },
  { valor: "descartavel", label: "Descartáveis" },
  { valor: "outro", label: "Outros" },
];

const MODOS_CONTROLE: { valor: ModoControleEstoque; label: string; hint: string }[] = [
  { valor: "quantidade", label: "Só por saldo", hint: "Avisa quando o saldo chega no mínimo." },
  {
    valor: "rendimento_usos",
    label: "Por usos ou atendimentos",
    hint: "Ex.: 6 embalagens que rendem 10 atendimentos cada aparecem como 60 usos disponíveis.",
  },
];

const FORMAS: { valor: FormaPagamento; label: string }[] = [
  { valor: "a_vista", label: "À vista" },
  { valor: "pix", label: "Pix" },
  { valor: "debito", label: "Débito" },
  { valor: "credito", label: "Crédito" },
];

const rotuloCategoria = new Map(CATEGORIAS.map((c) => [c.valor, c.label]));

function EstoquePage() {
  const { data: estoque, isPending, isError, error } = useEstoque();
  const { data: listaKits } = useKits();
  const { data: historico } = useMovimentacoes();

  const movimentacao = useCriarMovimentacao();
  const criarItem = useCriarItem();
  const editarItem = useEditarItem();
  const criarKit = useCriarKit();
  const montar = useMontarKit();
  const vender = useVenderKit();

  const [entradaItem, setEntradaItem] = useState<ItemEstoque | null>(null);
  const [saidaItem, setSaidaItem] = useState<ItemEstoque | null>(null);
  const [detalheItem, setDetalheItem] = useState<ItemEstoque | null>(null);
  const [itemParaEditar, setItemParaEditar] = useState<ItemEstoque | null>(null);
  const [tipoSaida, setTipoSaida] = useState<Exclude<TipoMovimentacao, "entrada">>("saida");
  const [qtd, setQtd] = useState("1");
  const [usosParciais, setUsosParciais] = useState("0");
  const [custo, setCusto] = useState("");
  const [motivo, setMotivo] = useState("");

  const [kitParaMontar, setKitParaMontar] = useState<Kit | null>(null);
  const [unidades, setUnidades] = useState("1");
  const [faltantes, setFaltantes] = useState<FaltanteEstoque[] | null>(null);

  const [kitParaVender, setKitParaVender] = useState<Kit | null>(null);
  const [qtdVenda, setQtdVenda] = useState("1");
  const [precoVenda, setPrecoVenda] = useState("");
  const [formaVenda, setFormaVenda] = useState<FormaPagamento>("pix");

  const [itemAberto, setItemAberto] = useState(false);
  const formItemInicial = {
    nome: "",
    categoria: "cilios" as CategoriaEstoque,
    unidade: "un" as UnidadeEstoque,
    quantidade: "0",
    minimo: "1",
    custo: "",
    codigoBarras: null as string | null,
    modoControle: "quantidade" as ModoControleEstoque,
    usosPorUnidade: "",
    usosMinimos: "",
  };
  const [formItem, setFormItem] = useState(formItemInicial);
  const [formEdicao, setFormEdicao] = useState({
    nome: "",
    categoria: "cilios" as CategoriaEstoque,
    unidade: "un" as UnidadeEstoque,
    minimo: "1",
    codigoBarras: "",
    modoControle: "quantidade" as ModoControleEstoque,
    usosPorUnidade: "",
    usosMinimos: "",
    confirmarUnidadeFisica: false,
  });

  const [buscaProduto, setBuscaProduto] = useState("");
  const [filtroStatus, setFiltroStatus] = useState<"todos" | StatusEstoque>("todos");
  const [filtroCategoria, setFiltroCategoria] = useState<"todas" | CategoriaEstoque>("todas");

  const [bipando, setBipando] = useState(false);
  const [buscandoCodigo, setBuscandoCodigo] = useState(false);

  const [kitAberto, setKitAberto] = useState(false);
  const [formKit, setFormKit] = useState<{
    nome: string;
    precoVenda: string;
    itens: { item_estoque_id: string; quantidade: number }[];
  }>({ nome: "", precoVenda: "", itens: [] });

  const itens = useMemo(() => estoque?.itens ?? [], [estoque]);
  const planejamento = estoque?.planejamento_reposicao ?? [];
  // Kits ainda consomem embalagens físicas (etapa 4). Não misturar com o
  // controle por usos evita que uma composição antiga tenha significado duplo.
  const itensParaKit = useMemo(
    () => itens.filter((item) => item.modo_controle !== "rendimento_usos"),
    [itens],
  );
  const kits = listaKits?.kits ?? [];

  // Quem está mais perto de acabar primeiro. Rendimento usa a capacidade de usos.
  const produtosFiltrados = useMemo(() => {
    const buscaNormalizada = buscaProduto.trim().toLocaleLowerCase("pt-BR");
    return itens
      .filter((item) => {
        const status = item.status_rendimento ?? item.status;
        return (
          (!buscaNormalizada || item.nome.toLocaleLowerCase("pt-BR").includes(buscaNormalizada)) &&
          (filtroStatus === "todos" || status === filtroStatus) &&
          (filtroCategoria === "todas" || item.categoria === filtroCategoria)
        );
      })
      .slice()
        .sort(
          (a, b) =>
            (a.usos_disponiveis ?? a.quantidade_atual) /
              ((a.usos_minimos ?? a.quantidade_minima) || 1) -
            (b.usos_disponiveis ?? b.quantidade_atual) /
              ((b.usos_minimos ?? b.quantidade_minima) || 1),
        );
  }, [buscaProduto, filtroCategoria, filtroStatus, itens]);

  const kitsProntos = kits.reduce((t, k) => t + k.quantidade_montada, 0);

  const abrirEntrada = (p: ItemEstoque) => {
    setEntradaItem(p);
    setQtd("1");
    setCusto(formatMoedaInput(String(Math.round(p.custo_ultima_compra * 100))));
    setMotivo("Compra");
  };

  const abrirEdicao = (item: ItemEstoque) => {
    setDetalheItem(null);
    setFormEdicao({
      nome: item.nome,
      categoria: item.categoria,
      unidade: item.unidade,
      minimo: String(item.quantidade_minima),
      codigoBarras: item.codigo_barras ?? "",
      modoControle: item.modo_controle,
      usosPorUnidade: item.usos_por_unidade == null ? "" : String(item.usos_por_unidade),
      usosMinimos: item.usos_minimos == null ? "" : String(item.usos_minimos),
      confirmarUnidadeFisica: false,
    });
    setItemParaEditar(item);
  };

  const abrirSaida = (p: ItemEstoque, tipo: "saida" | "ajuste" = "saida") => {
    setSaidaItem(p);
    setTipoSaida(tipo);
    if (tipo === "ajuste" && p.modo_controle === "rendimento_usos") {
      const embalagensInteiras = Math.floor(p.quantidade_atual);
      const usosDaParcial = (p.quantidade_atual - embalagensInteiras) * (p.usos_por_unidade ?? 1);
      setQtd(String(embalagensInteiras));
      setUsosParciais(String(Number(usosDaParcial.toFixed(3))));
    } else {
      setQtd(tipo === "ajuste" ? "" : "1");
      setUsosParciais("0");
    }
    setMotivo("");
  };

  const quantidadeEmbalagens = qtd.trim() === "" ? NaN : Number(qtd.replace(",", "."));
  const usosParciaisInformados = usosParciais.trim() === "" ? NaN : Number(usosParciais.replace(",", "."));
  const contagemParcialPorUsos =
    saidaItem?.modo_controle === "rendimento_usos" && tipoSaida === "ajuste";
  const quantidadeInformada = contagemParcialPorUsos
    ? quantidadeEmbalagens + usosParciaisInformados / (saidaItem?.usos_por_unidade ?? 1)
    : quantidadeEmbalagens;
  const quantidadeValida =
    Number.isFinite(quantidadeInformada) &&
    (saidaItem && tipoSaida === "ajuste" ? quantidadeInformada >= 0 : quantidadeInformada > 0) &&
    (!contagemParcialPorUsos ||
      (Number.isInteger(quantidadeEmbalagens) &&
        quantidadeEmbalagens >= 0 &&
        Number.isFinite(usosParciaisInformados) &&
        usosParciaisInformados >= 0 &&
        usosParciaisInformados < (saidaItem?.usos_por_unidade ?? 1)));
  const saldoPrevisto = entradaItem
    ? entradaItem.quantidade_atual + quantidadeInformada
    : saidaItem && tipoSaida === "saida"
      ? saidaItem.quantidade_atual - quantidadeInformada
      : quantidadeInformada;
  const quantidadeFormatada = (valor: number) =>
    valor.toLocaleString("pt-BR", { maximumFractionDigits: 3 });

  const confirmarEntrada = () => {
    if (!entradaItem) return;
    const quantidade = quantidadeInformada;
    const custoUnitario = parseMoedaInput(custo);
    if (!quantidadeValida || !Number.isFinite(custoUnitario) || custoUnitario < 0) {
      toast.error("Informe quantidade e custo válidos.");
      return;
    }
    movimentacao.mutate(
      {
        itemId: entradaItem.id,
        body: {
          tipo: "entrada",
          quantidade,
          motivo: motivo.trim() || "Compra",
          // É este custo que recalcula a média ponderada móvel (A6) — no servidor.
          custo_unitario: custoUnitario,
        },
      },
      {
        onSuccess: () => {
          toast.success(`Compra adicionada ao estoque de ${entradaItem.nome}.`);
          setEntradaItem(null);
        },
        onError: (erro) => toast.error(textoDoErro(erro)),
      },
    );
  };

  const confirmarSaida = () => {
    if (!saidaItem) return;
    const quantidade = quantidadeInformada;
    if (!quantidadeValida) {
      toast.error(
        tipoSaida === "ajuste"
          ? "Informe quanto restou, inclusive zero."
          : "Informe uma quantidade maior que zero.",
      );
      return;
    }
    if (tipoSaida === "saida" && quantidade > saidaItem.quantidade_atual) {
      toast.error("A saída é maior que o saldo disponível. Confira a quantidade em estoque.");
      return;
    }
    movimentacao.mutate(
      {
        itemId: saidaItem.id,
        body: {
          tipo: tipoSaida,
          quantidade,
          motivo:
            motivo.trim() || (tipoSaida === "saida" ? "Saída manual" : "Conferência de estoque"),
        },
      },
      {
        onSuccess: () => {
          toast.success(
            tipoSaida === "saida"
              ? "Saída registrada."
              : saidaItem.modo_controle === "rendimento_usos"
                ? `Contagem atualizada para ${quantidadeFormatada(quantidade * (saidaItem.usos_por_unidade ?? 1))} usos.`
                : `Quantidade atualizada para ${quantidadeFormatada(quantidade)} ${saidaItem.unidade}.`,
          );
          setSaidaItem(null);
        },
        onError: (erro) => toast.error(textoDoErro(erro)),
      },
    );
  };

  const cadastrarItem = () => {
    const quantidade = Number(formItem.quantidade.replace(",", "."));
    const minimo = Number(formItem.minimo.replace(",", "."));
    const custoUnitario = parseMoedaInput(formItem.custo);
    if (!formItem.nome.trim() || !(custoUnitario >= 0) || !Number.isFinite(quantidade)) {
      toast.error("Informe nome, quantidade e custo do produto.");
      return;
    }
    const usosPorUnidade = Number(formItem.usosPorUnidade.replace(",", "."));
    const usosMinimos = Number(formItem.usosMinimos.replace(",", "."));
    if (formItem.modoControle === "rendimento_usos" && !(usosPorUnidade > 0)) {
      toast.error("Informe quantos usos cada pote ou frasco rende.");
      return;
    }
    criarItem.mutate(
      {
        nome: formItem.nome.trim(),
        categoria: formItem.categoria,
        unidade: formItem.modoControle === "rendimento_usos" ? "un" : formItem.unidade,
        quantidade_atual: quantidade,
        quantidade_minima:
          formItem.modoControle === "rendimento_usos" ? 0 : Number.isFinite(minimo) ? minimo : 1,
        custo_unitario: custoUnitario,
        codigo_barras: formItem.codigoBarras,
        modo_controle: formItem.modoControle,
        usos_por_unidade: formItem.modoControle === "rendimento_usos" ? usosPorUnidade : null,
        usos_minimos:
          formItem.modoControle === "rendimento_usos" && Number.isFinite(usosMinimos)
            ? usosMinimos
            : 0,
      },
      {
        onSuccess: () => {
          setItemAberto(false);
          setFormItem(formItemInicial);
          toast.success("Produto cadastrado no estoque.");
        },
        onError: (erro) => toast.error(textoDoErro(erro)),
      },
    );
  };

  const salvarEdicao = () => {
    if (!itemParaEditar) return;

    const minimo = Number(formEdicao.minimo.replace(",", "."));
    const usosPorUnidade = Number(formEdicao.usosPorUnidade.replace(",", "."));
    const usosMinimos = Number(formEdicao.usosMinimos.replace(",", "."));
    const mudouParaUsos =
      itemParaEditar.modo_controle !== "rendimento_usos" &&
      formEdicao.modoControle === "rendimento_usos";

    if (!formEdicao.nome.trim()) {
      toast.error("Informe o nome do produto.");
      return;
    }
    if (mudouParaUsos && itemParaEditar.unidade !== "un" && !formEdicao.confirmarUnidadeFisica) {
      toast.error("Confirme que o saldo atual já está contado em embalagens.");
      return;
    }
    if (formEdicao.modoControle === "rendimento_usos" && !(usosPorUnidade > 0)) {
      toast.error("Informe quantos usos ou atendimentos cada embalagem rende.");
      return;
    }
    if (formEdicao.modoControle === "quantidade" && (!Number.isFinite(minimo) || minimo < 0)) {
      toast.error("Informe um estoque mínimo válido.");
      return;
    }
    if (formEdicao.modoControle === "rendimento_usos" && (!Number.isFinite(usosMinimos) || usosMinimos < 0)) {
      toast.error("Informe a quantidade de usos para o alerta.");
      return;
    }

    editarItem.mutate(
      {
        id: itemParaEditar.id,
        body: {
          nome: formEdicao.nome.trim(),
          categoria: formEdicao.categoria,
          unidade: formEdicao.modoControle === "rendimento_usos" ? "un" : formEdicao.unidade,
          quantidade_minima:
            formEdicao.modoControle === "rendimento_usos" ? 0 : minimo,
          codigo_barras: formEdicao.codigoBarras.trim() || null,
          modo_controle: formEdicao.modoControle,
          usos_por_unidade:
            formEdicao.modoControle === "rendimento_usos" ? usosPorUnidade : null,
          usos_minimos:
            formEdicao.modoControle === "rendimento_usos" ? usosMinimos : 0,
          ...(mudouParaUsos && itemParaEditar.unidade !== "un"
            ? { confirmar_unidade_fisica: formEdicao.confirmarUnidadeFisica }
            : {}),
        },
      },
      {
        onSuccess: () => {
          setItemParaEditar(null);
          toast.success("Produto atualizado.");
        },
        onError: (erro) => toast.error(textoDoErro(erro)),
      },
    );
  };

  /**
   * Bipagem: código novo → formulário de cadastro pré-preenchido com o
   * código; código já conhecido → direto para a entrada, para ela só
   * confirmar quantidade e custo (é a reposição de A6).
   */
  const aoDetectarCodigo = useCallback(
    (codigo: string) => {
      setBipando(false);
      setBuscandoCodigo(true);
      EstoqueApi.buscarPorCodigoBarras(codigo)
        .then((encontrado) => {
          if (encontrado) {
            toast.success(`Produto reconhecido: ${encontrado.nome}.`);
            abrirEntrada(encontrado);
          } else {
            setFormItem({ ...formItemInicial, codigoBarras: codigo });
            toast.message("Código novo — cadastre o produto.");
            setItemAberto(true);
          }
        })
        .catch((erro: unknown) => toast.error(textoDoErro(erro)))
        .finally(() => setBuscandoCodigo(false));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- abrirEntrada/textoDoErro são estáveis o bastante para este fluxo
    [],
  );

  const alternarItemKit = (itemId: string) => {
    const existe = formKit.itens.some((i) => i.item_estoque_id === itemId);
    setFormKit({
      ...formKit,
      itens: existe
        ? formKit.itens.filter((i) => i.item_estoque_id !== itemId)
        : [...formKit.itens, { item_estoque_id: itemId, quantidade: 1 }],
    });
  };

  const custoFormKit = formKit.itens.reduce((t, i) => {
    const p = itens.find((x) => x.id === i.item_estoque_id);
    return t + (p ? p.custo_medio * i.quantidade : 0);
  }, 0);

  const cadastrarKit = () => {
    const preco = parseMoedaInput(formKit.precoVenda);
    if (!formKit.nome.trim() || !(preco > 0) || formKit.itens.length === 0) {
      toast.error("Informe nome, preço de venda e ao menos um insumo.");
      return;
    }
    criarKit.mutate(
      { nome: formKit.nome.trim(), preco_venda: preco, itens: formKit.itens },
      {
        onSuccess: () => {
          setKitAberto(false);
          setFormKit({ nome: "", precoVenda: "", itens: [] });
          toast.success("Kit criado. Monte as unidades para começar a vender.");
        },
        onError: (erro) => toast.error(textoDoErro(erro)),
      },
    );
  };

  function confirmarMontagem(confirmarEstoqueInsuficiente: boolean) {
    if (!kitParaMontar) return;
    const quantidade = Number(unidades);
    if (!(quantidade > 0)) {
      toast.error("Informe quantas unidades deseja montar.");
      return;
    }
    montar.mutate(
      { id: kitParaMontar.id, quantidade, confirmar: confirmarEstoqueInsuficiente },
      {
        onSuccess: () => {
          toast.success(`${quantidade} unidade(s) de ${kitParaMontar.nome} montada(s).`);
          setFaltantes(null);
          setKitParaMontar(null);
        },
        onError: (erro) => {
          // Montar consome insumo: passa pelo mesmo aviso de A5 da finalização.
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

  function confirmarVenda() {
    if (!kitParaVender) return;
    const quantidade = Number(qtdVenda);
    const preco = parseMoedaInput(precoVenda);
    if (!(quantidade > 0)) {
      toast.error("Informe quantas unidades foram vendidas.");
      return;
    }
    vender.mutate(
      {
        id: kitParaVender.id,
        quantidade,
        formaPagamento: formaVenda,
        // Ausente vale o preço de cadastro; serve para o desconto de balcão.
        ...(preco > 0 && preco !== kitParaVender.preco_venda ? { precoUnitario: preco } : {}),
      },
      {
        onSuccess: () => {
          toast.success(`Venda registrada: ${kitParaVender.nome}.`);
          setKitParaVender(null);
        },
        // Sem segunda passada: `KIT_NAO_MONTADO` é definitivo (A7).
        onError: (erro) => toast.error(textoDoErro(erro)),
      },
    );
  }

  return (
    <AppShell
      titulo="Estoque"
      subtitulo="Saldo, custo médio e kits para revenda"
      acaoLabel="Novo produto"
      onAcao={() => setItemAberto(true)}
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Valor em estoque"
          value={formatBRL(estoque?.valor_total ?? 0)}
          tone="brand"
          destaque
        />
        <StatCard label="Produtos" value={String(itens.length)} />
        <StatCard
          label="Para repor"
          value={String(estoque?.total_alertas ?? 0)}
          tone={estoque && estoque.total_alertas > 0 ? "warning" : "positive"}
          hint="abaixo do mínimo"
        />
        <StatCard label="Kits prontos" value={String(kitsProntos)} />
      </div>

      <Tabs defaultValue="produtos" className="mt-5">
        <div className="overflow-x-auto pb-1">
          <TabsList className="h-11 min-w-max rounded-xl">
            <TabsTrigger value="produtos">Produtos</TabsTrigger>
            <TabsTrigger value="compras">Lista de compras</TabsTrigger>
            <TabsTrigger value="kits">Kits para revenda</TabsTrigger>
            <TabsTrigger value="movimentacoes">Movimentações</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="produtos" className="mt-4">
          <SectionTitle
            hint={
              itens.length
                ? `${produtosFiltrados.length} de ${itens.length} produto(s) exibido(s)`
                : "Bipe a embalagem para reconhecer o produto ou cadastrar um novo"
            }
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => setBipando(true)}
                disabled={buscandoCodigo}
              >
                <ScanBarcode className="size-4" />
                Bipar
              </Button>
            }
          >
            Produtos
          </SectionTitle>
          <div className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem_12rem]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={buscaProduto}
                onChange={(e) => setBuscaProduto(e.target.value)}
                className="pl-9"
                placeholder="Buscar por nome"
                aria-label="Buscar produto por nome"
              />
            </div>
            <Select value={filtroStatus} onValueChange={(v) => setFiltroStatus(v as "todos" | StatusEstoque)}>
              <SelectTrigger aria-label="Filtrar por status do estoque">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos os status</SelectItem>
                {Object.entries(rotuloStatus).map(([valor, label]) => (
                  <SelectItem key={valor} value={valor}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filtroCategoria} onValueChange={(v) => setFiltroCategoria(v as "todas" | CategoriaEstoque)}>
              <SelectTrigger aria-label="Filtrar por categoria">
                <SelectValue placeholder="Categoria" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todas">Todas as categorias</SelectItem>
                {CATEGORIAS.map((categoria) => (
                  <SelectItem key={categoria.valor} value={categoria.valor}>{categoria.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {isPending ? (
            <ListSkeleton />
          ) : isError ? (
            <EmptyState
              icon={<TriangleAlert className="size-5" />}
              titulo="Não deu para carregar o estoque"
              descricao={textoDoErro(error)}
            />
          ) : produtosFiltrados.length ? (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {produtosFiltrados.map((p) => (
                <li key={p.id}>
                  <Card className="p-4">
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{p.nome}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {rotuloCategoria.get(p.categoria) ?? p.categoria} •{" "}
                          {p.modo_controle === "rendimento_usos"
                            ? `cada embalagem rende ${quantidadeFormatada(p.usos_por_unidade ?? 0)} usos`
                            : `mínimo ${p.quantidade_minima} ${p.unidade}`}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <Pill tone={tomStatus[p.status_rendimento ?? p.status]}>
                            {p.modo_controle === "rendimento_usos"
                              ? rotuloStatus[p.status_rendimento ?? p.status].replace("Saldo", "Usos")
                              : rotuloStatus[p.status]}
                          </Pill>
                          <Pill>
                            {p.modo_controle === "rendimento_usos"
                              ? `Custo por uso ${formatBRL(p.custo_por_uso ?? 0)}`
                              : `Custo médio ${formatBRL(p.custo_medio)}`}
                          </Pill>
                          {p.modo_controle === "rendimento_usos" && (p.deficit_usos ?? 0) > 0 ? (
                            <Pill tone="warning">Faltam {quantidadeFormatada(p.deficit_usos ?? 0)} usos</Pill>
                          ) : p.deficit > 0 ? (
                            <Pill tone="warning">Faltam {p.deficit}</Pill>
                          ) : null}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p
                          className={
                            "font-display text-2xl font-semibold tabular-nums " +
                            ((p.status_rendimento ?? p.status) === "negativo" ||
                            (p.status_rendimento ?? p.status) === "critico"
                              ? "text-negative"
                              : (p.status_rendimento ?? p.status) === "alerta"
                                ? "text-warning"
                                : "text-foreground")
                          }
                        >
                          {quantidadeFormatada(p.usos_disponiveis ?? p.quantidade_atual)}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {p.modo_controle === "rendimento_usos"
                            ? `usos • ${quantidadeFormatada(p.quantidade_atual)} embalagem(ns)`
                            : p.unidade}
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
                      <Button size="sm" onClick={() => abrirEntrada(p)}>
                        <ArrowDownToLine className="size-4" />
                        {p.modo_controle === "rendimento_usos" ? "Adicionar embalagem" : "Adicionar compra"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => abrirSaida(p)}>
                        <ArrowUpFromLine className="size-4" />
                        Registrar perda/saída
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => abrirSaida(p, "ajuste")}>
                        <ClipboardCheck className="size-4" />
                        {p.modo_controle === "rendimento_usos" ? "Conferir embalagens" : "Conferir quantidade"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDetalheItem(p)}>
                        <History className="size-4" />
                        Ver detalhes
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => abrirEdicao(p)}>
                        <Pencil className="size-4" />
                        Editar
                      </Button>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<Package className="size-5" />}
              titulo={itens.length ? "Nenhum produto encontrado" : "Estoque vazio"}
              descricao={
                itens.length
                  ? "Tente ajustar a busca ou os filtros para encontrar o produto."
                  : "Cadastre seus produtos para acompanhar saldo, custo e reposição."
              }
              acao={
                itens.length ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setBuscaProduto("");
                      setFiltroStatus("todos");
                      setFiltroCategoria("todas");
                    }}
                  >
                    Limpar filtros
                  </Button>
                ) : (
                  <Button onClick={() => setItemAberto(true)}>Novo produto</Button>
                )
              }
            />
          )}
        </TabsContent>

        <TabsContent value="compras" className="mt-4">
          <SectionTitle hint="Baseada na agenda, no seu mínimo e no consumo dos últimos 30 dias">
            Lista de compras sugerida
          </SectionTitle>
          {planejamento.length ? (
            <>
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {planejamento.map((item) => (
                  <li key={item.item_id}>
                    <Card tone="warning" className="h-full p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="flex items-center gap-2 font-semibold">
                            <ShoppingBag className="size-4 shrink-0 text-warning" />
                            <span className="truncate">{item.nome}</span>
                          </p>
                          <p className="mt-2 text-sm text-muted-foreground">{item.base_calculo}</p>
                        </div>
                        <Pill tone="warning">
                          {item.embalagens_sugeridas != null
                            ? `${item.embalagens_sugeridas} embalagem(ns)`
                            : `${quantidadeFormatada(item.quantidade_sugerida)} ${item.unidade_consumo}(s)`}
                        </Pill>
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-sm text-muted-foreground">
                Esta lista não altera seu cadastro nem cria um gasto automaticamente.
              </p>
            </>
          ) : (
            <EmptyState
              icon={<ShoppingBag className="size-5" />}
              titulo="Nenhuma compra sugerida"
              descricao="Com o saldo e a agenda de hoje, não há reposições para planejar."
            />
          )}
        </TabsContent>

        <TabsContent value="kits" className="mt-4">
          <SectionTitle
            hint="Montar consome insumo; vender baixa o kit montado"
            action={
              <Button size="sm" onClick={() => setKitAberto(true)}>
                <Plus className="size-4" />
                Criar kit
              </Button>
            }
          >
            Kits para revenda
          </SectionTitle>
          {kits.length ? (
            <ul className="space-y-3">
              {kits.map((k) => (
                <li key={k.id}>
                  <Card className="p-4">
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{k.nome}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {k.itens.map((i) => `${i.quantidade}x ${i.nome}`).join(" • ")}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <Pill tone="brand">Venda {formatBRL(k.preco_venda)}</Pill>
                          <Pill>Custo {formatBRL(k.custo_total)}</Pill>
                          <Pill tone={k.margem >= 0 ? "positive" : "negative"}>
                            Lucro {formatBRL(k.margem)}
                          </Pill>
                          <Pill>Dá para montar {k.quantidade_montavel}</Pill>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-display text-2xl font-semibold tabular-nums">
                          {k.quantidade_montada}
                        </p>
                        <p className="text-[11px] text-muted-foreground">montados</p>
                        <div className="mt-2 flex flex-col gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setKitParaMontar(k);
                              setUnidades("1");
                            }}
                          >
                            <Boxes className="size-4" />
                            Montar
                          </Button>
                          <Button
                            size="sm"
                            disabled={k.quantidade_montada <= 0}
                            onClick={() => {
                              setKitParaVender(k);
                              setQtdVenda("1");
                              setPrecoVenda(
                                formatMoedaInput(String(Math.round(k.preco_venda * 100))),
                              );
                              setFormaVenda("pix");
                            }}
                          >
                            <ShoppingBag className="size-4" />
                            Vender
                          </Button>
                        </div>
                      </div>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<Boxes className="size-5" />}
              titulo="Nenhum kit cadastrado"
              descricao="Monte kits com o que você já tem no estoque e acompanhe a margem de cada um."
              acao={<Button onClick={() => setKitAberto(true)}>Criar kit</Button>}
            />
          )}
        </TabsContent>

        <TabsContent value="movimentacoes" className="mt-4">
          <SectionTitle hint="Entradas, saídas e ajustes mais recentes">Movimentações</SectionTitle>
          {historico?.movimentacoes.length ? (
            <Card className="p-2">
              <ul className="divide-y divide-border">
                {historico.movimentacoes.slice(0, 20).map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 px-2 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{m.item_nome}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(m.criado_em)} • {m.motivo}
                      </p>
                    </div>
                    <Pill
                      tone={
                        m.tipo === "entrada" ? "positive" : m.tipo === "saida" ? "neutral" : "brand"
                      }
                    >
                      {m.quantidade_consumida != null && m.unidade_consumo === "uso"
                        ? `${m.tipo === "entrada" ? "+" : m.tipo === "saida" ? "−" : "Ajuste: "}${quantidadeFormatada(m.quantidade_consumida)} uso(s)`
                        : m.saldo_anterior != null && m.saldo_atual != null
                        ? `${quantidadeFormatada(m.saldo_anterior)} → ${quantidadeFormatada(m.saldo_atual)}`
                        : `${m.tipo === "entrada" ? "+" : m.tipo === "saida" ? "−" : "Ajuste: "}${quantidadeFormatada(m.quantidade)}`}
                    </Pill>
                  </li>
                ))}
              </ul>
            </Card>
          ) : (
            <EmptyState
              icon={<Package className="size-5" />}
              titulo="Sem movimentações"
              descricao="Registre entradas de compras e saídas de uso para acompanhar o custo real."
            />
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={detalheItem !== null} onOpenChange={(aberto) => !aberto && setDetalheItem(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{detalheItem?.nome}</DialogTitle>
            <DialogDescription>
              {detalheItem?.modo_controle === "rendimento_usos"
                ? `Cada embalagem rende ${quantidadeFormatada(detalheItem.usos_por_unidade ?? 0)} usos.`
                : `Controle por ${detalheItem?.unidade}.`}
            </DialogDescription>
          </DialogHeader>
          {detalheItem ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 rounded-xl bg-muted p-3 text-sm">
                <div>
                  <p className="text-muted-foreground">Saldo atual</p>
                  <p className="font-semibold">
                    {detalheItem.modo_controle === "rendimento_usos"
                      ? `${quantidadeFormatada(detalheItem.usos_disponiveis ?? 0)} usos`
                      : `${quantidadeFormatada(detalheItem.quantidade_atual)} ${detalheItem.unidade}`}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Custo estimado</p>
                  <p className="font-semibold">
                    {detalheItem.modo_controle === "rendimento_usos"
                      ? `${formatBRL(detalheItem.custo_por_uso ?? 0)} por uso`
                      : `${formatBRL(detalheItem.custo_medio)} por ${detalheItem.unidade}`}
                  </p>
                </div>
              </div>
              <div>
                <p className="mb-2 text-sm font-medium">Últimas movimentações</p>
                {(historico?.movimentacoes.filter((m) => m.item_id === detalheItem.id) ?? []).length ? (
                  <ul className="max-h-52 divide-y divide-border overflow-y-auto rounded-xl border border-border px-3">
                    {historico?.movimentacoes
                      .filter((m) => m.item_id === detalheItem.id)
                      .slice(0, 10)
                      .map((m) => (
                        <li key={m.id} className="py-2 text-sm">
                          <p>{m.motivo}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatDateTime(m.criado_em)} • {m.quantidade_consumida != null && m.unidade_consumo === "uso"
                              ? `${quantidadeFormatada(m.quantidade_consumida)} uso(s)`
                              : `${quantidadeFormatada(m.quantidade)} ${detalheItem.unidade}`}
                          </p>
                        </li>
                      ))}
                  </ul>
                ) : (
                  <p className="rounded-xl border border-dashed border-border p-3 text-sm text-muted-foreground">
                    Ainda não há movimentações para este produto.
                  </p>
                )}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetalheItem(null)}>Fechar</Button>
            {detalheItem ? (
              <>
                <Button variant="outline" onClick={() => abrirEdicao(detalheItem)}>
                  <Pencil className="size-4" />
                  Editar produto
                </Button>
                <Button
                  onClick={() => {
                    const item = detalheItem;
                    setDetalheItem(null);
                    abrirSaida(item, "ajuste");
                  }}
                >
                  <ClipboardCheck className="size-4" />
                  Conferir saldo
                </Button>
              </>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edição mantém saldo e custo no histórico; só altera o cadastro e o modo de alerta. */}
      <Dialog
        open={itemParaEditar !== null}
        onOpenChange={(aberto) => !aberto && setItemParaEditar(null)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Editar produto</DialogTitle>
            <DialogDescription>
              Altere os dados de cadastro e a forma de acompanhar a reposição. Saldo e custo são ajustados pelas ações de estoque.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="editar-nome-produto">Nome do produto</Label>
              <Input
                id="editar-nome-produto"
                value={formEdicao.nome}
                onChange={(e) => setFormEdicao((form) => ({ ...form, nome: e.target.value }))}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Categoria</Label>
                <Select
                  value={formEdicao.categoria}
                  onValueChange={(v) =>
                    setFormEdicao((form) => ({ ...form, categoria: v as CategoriaEstoque }))
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIAS.map((categoria) => (
                      <SelectItem key={categoria.valor} value={categoria.valor}>{categoria.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>
                  {formEdicao.modoControle === "rendimento_usos" ? "Controle físico" : "Unidade de medida"}
                </Label>
                <Select
                  value={formEdicao.unidade}
                  onValueChange={(v) =>
                    setFormEdicao((form) => ({ ...form, unidade: v as UnidadeEstoque }))
                  }
                  disabled={formEdicao.modoControle === "rendimento_usos"}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {UNIDADES.map((unidade) => (
                      <SelectItem key={unidade.valor} value={unidade.valor}>{unidade.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Como avisar que está acabando</Label>
              <Select
                value={formEdicao.modoControle}
                onValueChange={(v) => {
                  const modoControle = v as ModoControleEstoque;
                  setFormEdicao((form) => ({
                    ...form,
                    modoControle,
                    unidade: modoControle === "rendimento_usos" ? "un" : form.unidade,
                  }));
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MODOS_CONTROLE.map((modo) => (
                    <SelectItem
                      key={modo.valor}
                      value={modo.valor}
                    >
                      {modo.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {MODOS_CONTROLE.find((modo) => modo.valor === formEdicao.modoControle)?.hint}
              </p>
            </div>
            {itemParaEditar &&
            itemParaEditar.modo_controle !== "rendimento_usos" &&
            itemParaEditar.unidade !== "un" &&
            formEdicao.modoControle === "rendimento_usos" ? (
              <div className="space-y-3 rounded-xl border border-warning/30 bg-warning/10 p-3 text-sm">
                <p className="text-foreground">
                  O saldo atual está em {itemParaEditar.unidade}. Ao salvar, ele passará a ser lido como embalagens; confira antes se {quantidadeFormatada(itemParaEditar.quantidade_atual)} representa mesmo essa quantidade de embalagens.
                </p>
                <div className="flex items-center gap-2">
                  <Switch
                    id="confirmar-unidade-fisica"
                    checked={formEdicao.confirmarUnidadeFisica}
                    onCheckedChange={(checked) =>
                      setFormEdicao((form) => ({ ...form, confirmarUnidadeFisica: checked }))
                    }
                  />
                  <Label htmlFor="confirmar-unidade-fisica" className="text-sm font-medium">
                    Conferi: o saldo atual é de embalagens
                  </Label>
                </div>
              </div>
            ) : null}
            {formEdicao.modoControle === "rendimento_usos" ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="editar-usos-por-unidade">Usos por embalagem</Label>
                    <Input
                      id="editar-usos-por-unidade"
                      inputMode="decimal"
                      value={formEdicao.usosPorUnidade}
                      onChange={(e) => setFormEdicao((form) => ({ ...form, usosPorUnidade: e.target.value }))}
                      placeholder="Ex.: 10"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="editar-usos-minimos">Alertar quando restarem</Label>
                    <Input
                      id="editar-usos-minimos"
                      inputMode="decimal"
                      value={formEdicao.usosMinimos}
                      onChange={(e) => setFormEdicao((form) => ({ ...form, usosMinimos: e.target.value }))}
                      placeholder="Usos"
                    />
                  </div>
                </div>
                {itemParaEditar?.modo_controle !== "rendimento_usos" ? (
                  <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">
                    O saldo atual de {quantidadeFormatada(itemParaEditar?.quantidade_atual ?? 0)} embalagem(ns) passará a representar {quantidadeFormatada((itemParaEditar?.quantidade_atual ?? 0) * (Number(formEdicao.usosPorUnidade.replace(",", ".")) || 0))} usos. Revise a quantidade usada nos serviços vinculados a este produto.
                  </p>
                ) : null}
              </>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="editar-minimo">Estoque mínimo</Label>
                <Input
                  id="editar-minimo"
                  inputMode="decimal"
                  value={formEdicao.minimo}
                  onChange={(e) => setFormEdicao((form) => ({ ...form, minimo: e.target.value }))}
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="editar-codigo-barras">Código de barras (opcional)</Label>
              <Input
                id="editar-codigo-barras"
                value={formEdicao.codigoBarras}
                onChange={(e) => setFormEdicao((form) => ({ ...form, codigoBarras: e.target.value }))}
                placeholder="Sem código"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setItemParaEditar(null)} disabled={editarItem.isPending}>
              Cancelar
            </Button>
            <Button onClick={salvarEdicao} disabled={editarItem.isPending}>
              <Pencil className="size-4" />
              Salvar alterações
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Entrada */}
      <Dialog open={entradaItem !== null} onOpenChange={(o) => !o && setEntradaItem(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Adicionar compra</DialogTitle>
            <DialogDescription>
              {entradaItem?.nome} — saldo atual {entradaItem?.quantidade_atual}{" "}
              {entradaItem?.modo_controle === "rendimento_usos" ? "embalagem(ns)" : entradaItem?.unidade}. Informe o que chegou para acrescentar ao estoque.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="qtd-entrada">
                Quantidade comprada ({entradaItem?.modo_controle === "rendimento_usos" ? "embalagens" : entradaItem?.unidade})
              </Label>
              <Input
                id="qtd-entrada"
                inputMode="decimal"
                value={qtd}
                onChange={(e) => setQtd(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="custo-entrada">
                Preço por {entradaItem?.modo_controle === "rendimento_usos" ? "embalagem" : entradaItem?.unidade} (R$)
              </Label>
              <Input
                id="custo-entrada"
                inputMode="decimal"
                value={custo}
                onChange={(e) => setCusto(formatMoedaInput(e.target.value))}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="motivo-entrada">Motivo</Label>
              <Input
                id="motivo-entrada"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Ex.: compra na Bella Lash"
              />
            </div>
          </div>
          {quantidadeValida && entradaItem ? (
            <p role="status" className="rounded-xl bg-muted p-3 text-sm">
              Prévia: {quantidadeFormatada(entradaItem.quantidade_atual)} +{" "}
              {quantidadeFormatada(quantidadeInformada)} = {quantidadeFormatada(saldoPrevisto)}{" "}
              {entradaItem.modo_controle === "rendimento_usos" ? "embalagens" : entradaItem.unidade} em estoque.
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEntradaItem(null)}
              disabled={movimentacao.isPending}
            >
              Cancelar
            </Button>
            <Button
              onClick={confirmarEntrada}
              disabled={movimentacao.isPending || !quantidadeValida}
            >
              {quantidadeValida
                ? `Adicionar ${quantidadeFormatada(quantidadeInformada)} ${entradaItem?.modo_controle === "rendimento_usos" ? "embalagem(ns)" : entradaItem?.unidade ?? ""}`
                : "Adicionar compra"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Saída ou ajuste */}
      <Dialog open={saidaItem !== null} onOpenChange={(o) => !o && setSaidaItem(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {tipoSaida === "ajuste" ? "Conferir quantidade" : "Registrar saída"}
            </DialogTitle>
            <DialogDescription>
              {saidaItem?.nome} — saldo atual {saidaItem?.quantidade_atual}{" "}
              {saidaItem?.modo_controle === "rendimento_usos" ? "embalagem(ns)" : saidaItem?.unidade}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
                {tipoSaida === "saida"
                ? "Informe o que saiu por perda, descarte ou devolução. Produtos já descontados ao finalizar um atendimento não precisam de outra saída."
                : "Conte quanto realmente restou. Esse será o novo saldo; informe 0 se acabou."}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="qtd-saida">
                {tipoSaida === "ajuste" && saidaItem?.modo_controle === "rendimento_usos"
                  ? "Embalagens completas que restaram"
                  : `${tipoSaida === "ajuste" ? "Quantidade que restou" : "Quantidade que saiu"} (${saidaItem?.modo_controle === "rendimento_usos" ? "embalagens" : saidaItem?.unidade})`}
              </Label>
              <Input
                id="qtd-saida"
                inputMode="decimal"
                value={qtd}
                placeholder={tipoSaida === "ajuste" ? "Ex.: 4" : "Ex.: 1"}
                onChange={(e) => setQtd(e.target.value)}
              />
            </div>
            {contagemParcialPorUsos ? (
              <div className="space-y-1.5">
                <Label htmlFor="usos-parciais">
                  Usos restantes na embalagem em andamento (0 a {(saidaItem?.usos_por_unidade ?? 1) - 1})
                </Label>
                <Input
                  id="usos-parciais"
                  inputMode="decimal"
                  value={usosParciais}
                  onChange={(e) => setUsosParciais(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Ex.: 4 embalagens e 3 usos de um pote que rende 10 equivalem a 43 usos.
                </p>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="motivo-saida">Motivo</Label>
              <Input
                id="motivo-saida"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder={
                  tipoSaida === "saida" ? "Ex.: perda de produto" : "Ex.: contagem do mês"
                }
              />
            </div>
          </div>
          {quantidadeValida && saidaItem ? (
            <p role="status" className="rounded-xl bg-muted p-3 text-sm">
              {tipoSaida === "ajuste"
                ? saidaItem.modo_controle === "rendimento_usos"
                  ? `Prévia: o saldo passará de ${quantidadeFormatada(saidaItem.usos_disponiveis ?? 0)} para ${quantidadeFormatada(saldoPrevisto * (saidaItem.usos_por_unidade ?? 1))} usos.`
                  : `Prévia: o saldo passará de ${quantidadeFormatada(saidaItem.quantidade_atual)} para ${quantidadeFormatada(saldoPrevisto)} ${saidaItem.unidade}.`
                : saldoPrevisto < 0
                  ? "Essa saída é maior que o saldo disponível. Confira a quantidade em estoque antes de registrar."
                  : `Prévia: ${quantidadeFormatada(saidaItem.quantidade_atual)} − ${quantidadeFormatada(quantidadeInformada)} = ${quantidadeFormatada(saldoPrevisto)} ${saidaItem.modo_controle === "rendimento_usos" ? "embalagens" : saidaItem.unidade} em estoque.`}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSaidaItem(null)}
              disabled={movimentacao.isPending}
            >
              Cancelar
            </Button>
            <Button
              onClick={confirmarSaida}
              disabled={
                movimentacao.isPending ||
                !quantidadeValida ||
                (tipoSaida === "saida" && saldoPrevisto < 0)
              }
            >
              {tipoSaida === "ajuste" && quantidadeValida
                ? saidaItem?.modo_controle === "rendimento_usos"
                  ? `Atualizar para ${quantidadeFormatada(quantidadeInformada * (saidaItem.usos_por_unidade ?? 1))} usos`
                  : `Atualizar para ${quantidadeFormatada(quantidadeInformada)} ${saidaItem?.unidade ?? ""}`
                : tipoSaida === "ajuste"
                  ? "Atualizar quantidade"
                  : "Registrar saída"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Montar kit */}
      <Dialog open={kitParaMontar !== null} onOpenChange={(o) => !o && setKitParaMontar(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Montar kit</DialogTitle>
            <DialogDescription>
              {kitParaMontar?.nome} — os insumos serão baixados do estoque. Dá para montar{" "}
              {kitParaMontar?.quantidade_montavel} com o saldo de hoje.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="unidades">Unidades</Label>
            <Input
              id="unidades"
              inputMode="numeric"
              value={unidades}
              onChange={(e) => setUnidades(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setKitParaMontar(null)}
              disabled={montar.isPending}
            >
              Cancelar
            </Button>
            <Button onClick={() => confirmarMontagem(false)} disabled={montar.isPending}>
              Montar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BarcodeScannerDialog
        open={bipando}
        onOpenChange={setBipando}
        onDetectado={aoDetectarCodigo}
      />

      <EstoqueInsuficienteDialog
        faltantes={faltantes}
        acao={`montar ${unidades} kit(s)`}
        confirmando={montar.isPending}
        onCancelar={() => setFaltantes(null)}
        onConfirmar={() => confirmarMontagem(true)}
      />

      {/* Vender kit */}
      <Dialog open={kitParaVender !== null} onOpenChange={(o) => !o && setKitParaVender(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Vender kit</DialogTitle>
            <DialogDescription>
              {kitParaVender?.nome} — {kitParaVender?.quantidade_montada} montado(s) na prateleira.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="qtd-venda">Unidades</Label>
                <Input
                  id="qtd-venda"
                  inputMode="numeric"
                  value={qtdVenda}
                  onChange={(e) => setQtdVenda(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="preco-venda">Preço unitário (R$)</Label>
                <Input
                  id="preco-venda"
                  inputMode="decimal"
                  value={precoVenda}
                  onChange={(e) => setPrecoVenda(formatMoedaInput(e.target.value))}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Forma de pagamento</Label>
              <Select value={formaVenda} onValueChange={(v) => setFormaVenda(v as FormaPagamento)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FORMAS.map((f) => (
                    <SelectItem key={f.valor} value={f.valor}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setKitParaVender(null)}
              disabled={vender.isPending}
            >
              Cancelar
            </Button>
            <Button onClick={confirmarVenda} disabled={vender.isPending}>
              Registrar venda
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Novo produto */}
      <Dialog
        open={itemAberto}
        onOpenChange={(o) => {
          setItemAberto(o);
          if (!o) {
            setFormItem((f) => ({ ...f, codigoBarras: null }));
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Novo produto</DialogTitle>
            <DialogDescription>
              Cadastre o insumo com nome, unidade de medida, saldo inicial e custo.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {formItem.codigoBarras ? (
              <div className="flex items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                <ScanBarcode className="size-4 shrink-0" />
                Código bipado:{" "}
                <span className="font-medium text-foreground">{formItem.codigoBarras}</span>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="nome-produto">Nome do produto</Label>
              <Input
                id="nome-produto"
                value={formItem.nome}
                onChange={(e) => {
                  setFormItem((f) => ({ ...f, nome: e.target.value }));
                }}
                placeholder="Ex.: cola para extensão de cílios"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Categoria</Label>
                <Select
                  value={formItem.categoria}
                  onValueChange={(v) =>
                    setFormItem({ ...formItem, categoria: v as CategoriaEstoque })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIAS.map((c) => (
                      <SelectItem key={c.valor} value={c.valor}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{formItem.modoControle === "rendimento_usos" ? "Controle físico" : "Unidade de medida"}</Label>
                <Select
                  value={formItem.unidade}
                  onValueChange={(v) => setFormItem({ ...formItem, unidade: v as UnidadeEstoque })}
                  disabled={formItem.modoControle === "rendimento_usos"}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {UNIDADES.map((u) => (
                      <SelectItem key={u.valor} value={u.valor}>
                        {u.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qtd-inicial">
                  {formItem.modoControle === "rendimento_usos" ? "Embalagens em estoque" : "Saldo inicial"}
                </Label>
                <Input
                  id="qtd-inicial"
                  inputMode="decimal"
                  value={formItem.quantidade}
                  onChange={(e) => setFormItem({ ...formItem, quantidade: e.target.value })}
                />
              </div>
              {formItem.modoControle !== "rendimento_usos" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="minimo">Estoque mínimo</Label>
                  <Input
                    id="minimo"
                    inputMode="decimal"
                    value={formItem.minimo}
                    onChange={(e) => setFormItem({ ...formItem, minimo: e.target.value })}
                  />
                </div>
              ) : null}
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="custo-produto">Custo unitário (R$)</Label>
                <Input
                  id="custo-produto"
                  inputMode="decimal"
                  value={formItem.custo}
                  onChange={(e) =>
                    setFormItem({ ...formItem, custo: formatMoedaInput(e.target.value) })
                  }
                  placeholder="0,00"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Como avisar que está acabando</Label>
              <Select
                value={formItem.modoControle}
                onValueChange={(v) => {
                  const modoControle = v as ModoControleEstoque;
                  setFormItem({
                    ...formItem,
                    modoControle,
                    unidade: modoControle === "rendimento_usos" ? "un" : formItem.unidade,
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODOS_CONTROLE.map((m) => (
                    <SelectItem key={m.valor} value={m.valor}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {MODOS_CONTROLE.find((m) => m.valor === formItem.modoControle)?.hint}
              </p>
            </div>
            {formItem.modoControle === "rendimento_usos" ? (
              <div className="space-y-1.5">
                <Label htmlFor="usos-por-unidade">Quantos usos rende cada embalagem</Label>
                <Input
                  id="usos-por-unidade"
                  inputMode="decimal"
                  value={formItem.usosPorUnidade}
                  onChange={(e) => setFormItem({ ...formItem, usosPorUnidade: e.target.value })}
                  placeholder="Ex.: 10"
                />
              </div>
            ) : null}
            {formItem.modoControle === "rendimento_usos" ? (
              <div className="space-y-1.5">
                <Label htmlFor="usos-minimos">Avisar quando restarem (usos)</Label>
                <Input
                  id="usos-minimos"
                  inputMode="decimal"
                  value={formItem.usosMinimos}
                  onChange={(e) => setFormItem({ ...formItem, usosMinimos: e.target.value })}
                  placeholder="Ex.: 10"
                />
                <p className="text-xs text-muted-foreground">A capacidade começa a contar no cadastro.</p>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setItemAberto(false)}
              disabled={criarItem.isPending}
            >
              Cancelar
            </Button>
            <Button onClick={cadastrarItem} disabled={criarItem.isPending}>
              <PackagePlus className="size-4" />
              Cadastrar produto
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Criar kit */}
      <Dialog open={kitAberto} onOpenChange={setKitAberto}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Criar kit para revenda</DialogTitle>
            <DialogDescription>
              Escolha os produtos que compõem o kit e o preço de venda.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="nome-kit">Nome do kit</Label>
              <Input
                id="nome-kit"
                value={formKit.nome}
                onChange={(e) => setFormKit({ ...formKit, nome: e.target.value })}
                placeholder="Ex.: kit cuidados com cílios"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="preco-kit">Preço de venda (R$)</Label>
              <Input
                id="preco-kit"
                inputMode="decimal"
                value={formKit.precoVenda}
                onChange={(e) =>
                  setFormKit({ ...formKit, precoVenda: formatMoedaInput(e.target.value) })
                }
                placeholder="0,00"
              />
            </div>
            <div className="space-y-2">
              <Label>Produtos do kit</Label>
              <div className="max-h-52 space-y-1.5 overflow-y-auto rounded-xl border border-border p-2">
                {itensParaKit.map((p) => {
                  const item = formKit.itens.find((i) => i.item_estoque_id === p.id);
                  return (
                    <div key={p.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
                      <Switch
                        checked={item !== undefined}
                        onCheckedChange={() => alternarItemKit(p.id)}
                        aria-label={p.nome}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">{p.nome}</span>
                      {item ? (
                        <Input
                          className="h-9 w-16"
                          inputMode="numeric"
                          value={String(item.quantidade)}
                          onChange={(e) =>
                            setFormKit({
                              ...formKit,
                              itens: formKit.itens.map((i) =>
                                i.item_estoque_id === p.id
                                  ? { ...i, quantidade: Number(e.target.value) || 1 }
                                  : i,
                              ),
                            })
                          }
                        />
                      ) : (
                        <span className="text-[11px] text-muted-foreground">{p.unidade}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              {itensParaKit.length !== itens.length ? (
                <p className="text-xs text-muted-foreground">
                  Produtos controlados por usos ficam disponíveis para atendimentos; kits terão esse suporte na próxima etapa.
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Custo dos insumos: <Money value={custoFormKit} /> • Lucro por kit:{" "}
                <Money value={parseMoedaInput(formKit.precoVenda) - custoFormKit} colorir />
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setKitAberto(false)}
              disabled={criarKit.isPending}
            >
              Cancelar
            </Button>
            <Button onClick={cadastrarKit} disabled={criarKit.isPending}>
              <Boxes className="size-4" />
              Criar kit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
