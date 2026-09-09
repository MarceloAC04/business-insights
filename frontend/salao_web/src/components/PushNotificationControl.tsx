import { BellRing, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AppEnvironment } from "@/lib/env";
import { useRegistrarDispositivo, useSessao } from "@/lib/queries";
import {
  assinaturaParaApi,
  obterAssinaturaWebPush,
  textoDoErroPush,
  webPushDisponivel,
} from "@/lib/web-push";

type Estado = "verificando" | "perguntar" | "ativo" | "bloqueado" | "indisponivel";

function chaveDoAviso(usuarioId: string): string {
  return `glowapp:notificacoes-pergunta:${usuarioId}`;
}

function avisoJaFoiDispensado(usuarioId: string): boolean {
  try {
    return window.sessionStorage.getItem(chaveDoAviso(usuarioId)) === "1";
  } catch {
    return false;
  }
}

function dispensarAviso(usuarioId: string): void {
  try {
    window.sessionStorage.setItem(chaveDoAviso(usuarioId), "1");
  } catch {
    // O aviso continua funcionando mesmo quando o navegador bloqueia o storage.
  }
}

export function PushNotificationControl() {
  const { data: sessao } = useSessao();
  const registrar = useRegistrarDispositivo();
  const [estado, setEstado] = useState<Estado>("verificando");
  const [ativando, setAtivando] = useState(false);
  const [erroAtivacao, setErroAtivacao] = useState<string | null>(null);
  const tentativa = useRef<object | null>(null);
  const avisoFechado = useRef(false);

  async function sincronizar(pedirPermissao: boolean): Promise<void> {
    if (tentativa.current) return;
    const operacao = {};
    tentativa.current = operacao;
    const aindaAtual = () => tentativa.current === operacao && !avisoFechado.current;
    if (pedirPermissao) {
      setAtivando(true);
      setErroAtivacao(null);
    }
    try {
      const assinatura = await obterAssinaturaWebPush(pedirPermissao);
      if (!aindaAtual()) return;
      if (!assinatura) {
        if (!pedirPermissao && sessao && avisoJaFoiDispensado(sessao.usuario.id)) {
          setEstado("indisponivel");
          return;
        }
        if (pedirPermissao) {
          setErroAtivacao(
            Notification.permission === "denied"
              ? "As notificações estão bloqueadas. Libere a permissão deste site nas configurações do navegador para ativá-las."
              : "A permissão não foi concedida. Toque em tentar novamente e permita as notificações no navegador.",
          );
        }
        setEstado(
          !pedirPermissao && Notification.permission === "denied" ? "bloqueado" : "perguntar",
        );
        return;
      }
      const body = assinaturaParaApi(assinatura);
      await registrar.mutateAsync({
        token: body.endpoint,
        plataforma: "web",
        modelo: navigator.userAgent.slice(0, 180),
        assinatura_web_push: body,
      });
      if (!aindaAtual()) return;
      setEstado("ativo");
      if (pedirPermissao) toast.success("Notificações ativadas neste dispositivo.");
    } catch (erro) {
      if (!aindaAtual()) return;
      const dispensado = sessao && avisoJaFoiDispensado(sessao.usuario.id);
      setEstado(!pedirPermissao && dispensado ? "indisponivel" : "perguntar");
      setErroAtivacao(textoDoErroPush(erro));
    } finally {
      if (tentativa.current === operacao) {
        tentativa.current = null;
        setAtivando(false);
      }
    }
  }

  useEffect(() => {
    avisoFechado.current = false;
    setErroAtivacao(null);
    setAtivando(false);
    function verificar(): void {
      if (!sessao || AppEnvironment.isDemo || !webPushDisponivel()) {
        setEstado("indisponivel");
        return;
      }
      if (Notification.permission === "denied") {
        setEstado("bloqueado");
        return;
      }
      if (Notification.permission === "default") {
        setEstado(avisoJaFoiDispensado(sessao.usuario.id) ? "indisponivel" : "perguntar");
        return;
      }
      void sincronizar(false);
    }
    verificar();
    return () => {
      tentativa.current = null;
    };
    // A sessão é a única identidade relevante; o registro é idempotente por endpoint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessao?.usuario?.id]);

  function fecharAviso(): void {
    avisoFechado.current = true;
    if (sessao) dispensarAviso(sessao.usuario.id);
    setEstado("indisponivel");
  }

  if (estado !== "perguntar") return null;

  return (
    <Dialog open onOpenChange={(aberto) => !aberto && fecharAviso()}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl p-5 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary-accent">
              <BellRing className="size-5" />
            </span>
            Receba os avisos do salão
          </DialogTitle>
          <DialogDescription>
            Podemos avisar você sobre novos agendamentos, atendimentos e outros alertas importantes,
            mesmo quando você estiver em outra tela.
          </DialogDescription>
        </DialogHeader>
        {erroAtivacao && (
          <div
            role="alert"
            className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"
          >
            <p>{erroAtivacao}</p>
            <p className="mt-2">Você pode continuar acompanhando os avisos na tela de Alertas.</p>
          </div>
        )}
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button type="button" variant="ghost" onClick={fecharAviso}>
            Agora não
          </Button>
          <Button
            type="button"
            disabled={ativando}
            aria-busy={ativando}
            onClick={() => void sincronizar(true)}
          >
            {ativando ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <BellRing className="size-4" />
            )}
            {ativando ? "Ativando…" : erroAtivacao ? "Tentar novamente" : "Ativar notificações"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
