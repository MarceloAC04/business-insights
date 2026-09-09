from datetime import datetime

from pydantic import BaseModel, Field


class SalaoPublicoOut(BaseModel):
    nome: str
    foto_url: str | None = None
    telefone_whatsapp: str = ""
    instagram_url: str = ""
    endereco: str = ""
    descricao_publica: str = ""
    horarios: list["HorarioPublicoOut"] = Field(default_factory=list)


class HorarioPublicoOut(BaseModel):
    dia_semana: int
    ativo: bool
    hora_inicio: str | None = None
    hora_fim: str | None = None
    hora_inicio_2: str | None = None
    hora_fim_2: str | None = None


class ServicoPublicoOut(BaseModel):
    id: str
    nome: str
    descricao: str = ""
    categoria: str = "Outros"
    preco: float
    duracao_minutos: int


class AgendamentoPublicoOut(BaseModel):
    salao: SalaoPublicoOut
    servicos: list[ServicoPublicoOut]


class HorariosDisponiveisOut(BaseModel):
    duracao_total_minutos: int
    horarios: list[str]


class AgendarServicoItem(BaseModel):
    servico_id: str


class AgendarRequest(BaseModel):
    cliente_nome: str = Field(min_length=1)
    cliente_telefone: str = Field(min_length=1)
    data: datetime
    servicos: list[AgendarServicoItem] = Field(min_length=1)


class ServicoAgendadoOut(BaseModel):
    servico_id: str
    nome: str
    preco: float


class AgendamentoCriadoOut(BaseModel):
    id: str
    data: datetime
    status: str
    servicos: list[ServicoAgendadoOut]
