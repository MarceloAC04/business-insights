"""Cálculos puros para insumos controlados por rendimento de usos.

O banco guarda quantas embalagens físicas ainda existem. Quando um produto
rende usos, serviços e atendimentos trabalham com a capacidade que interessa
na operação: `embalagens × usos_por_unidade`. Centralizar a conversão evita
que custo, alerta e baixa discordem entre si.
"""


def e_rendimento(item: dict) -> bool:
    return (item.get("modo_controle") or "quantidade") == "rendimento_usos"


def usos_por_unidade(item: dict) -> float:
    valor = float(item.get("usos_por_unidade") or 0)
    if valor <= 0:
        raise ValueError("Item em rendimento_usos sem usos_por_unidade válido")
    return valor


def unidade_consumo(item: dict) -> str:
    return "uso" if e_rendimento(item) else str(item.get("unidade") or "un")


def nome_unidade(quantidade: float, unidade: str) -> str:
    """Devolve a unidade no singular/plural sem pluralizar abreviações físicas."""
    if unidade == "uso":
        return "uso" if quantidade == 1 else "usos"
    return unidade


def rotulo_quantidade(quantidade: float, unidade: str) -> str:
    return f"{quantidade:g} {nome_unidade(quantidade, unidade)}"


def quantidade_fisica_consumida(item: dict, quantidade_consumo: float) -> float:
    """Converte usos em fração de embalagem; itens comuns passam sem alteração."""
    return quantidade_consumo / usos_por_unidade(item) if e_rendimento(item) else quantidade_consumo


def quantidade_consumo_disponivel(item: dict) -> float:
    quantidade_fisica = float(item.get("quantidade_atual") or 0)
    return quantidade_fisica * usos_por_unidade(item) if e_rendimento(item) else quantidade_fisica


def custo_por_unidade_consumo(item: dict) -> float:
    custo_fisico = float(item.get("custo_medio") or 0)
    return custo_fisico / usos_por_unidade(item) if e_rendimento(item) else custo_fisico
