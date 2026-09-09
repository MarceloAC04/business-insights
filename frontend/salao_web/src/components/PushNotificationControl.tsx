import { BellRing } from "lucide-react";
import { useEffect, useState } from "react";
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
import { ApiError } from "@/lib/error-codes";
import { textoDoErro, useRegistrarDispositivo, useSessao } from "@/lib/queries";
import { assinaturaParaApi, obterAssinaturaWebPush, webPushDisponivel } from "@/lib/web-push";

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

function textoDoErroPush(erro: unknown): string {
  if (erro instanceof ApiError) return textoDoErro(erro);
  if (typeof DOMException !== "undefined" && erro instanceof DOMException) {
    if (erro.name === "NotAllowedError") {
      return "O navegador bloqueou as notificações. Libere a permissão deste site e tente novamente.";
    }
    if (erro.name === "InvalidStateError") {
      return "O navegador ainda está preparando as notificações. Atualize a página e tente novamente.";
    }
  }
  if (erro instanceof Error && erro.message) return erro.message;
  return "Não foi possível ativar as notificações. Verifique a permissão do navegador e tente novamente.";
}

export function PushNotificationControl() {
  const { data: sessao } = useSessao();
  const registrar = useRegistrarDispositivo();
  const [estado, setEstado] = useState<Estado>("verificando");

  async function sincronizar(pedirPermissao: boolean): Promise<void> {
    try {
      const assinatura = await obterAssinaturaWebPush(pedirPermissao);
      if (!assinatura) {
        setEstado(
          typeof Notification !== "undefined" && Notification.permission === "denied"
            ? "bloqueado"
            : "perguntar",
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
      setEstado("ativo");
      if (pedirPermissao) toast.success("Notificações ativadas neste celular.");
    } catch (erro) {
      setEstado(
        typeof Notification !== "undefined" && Notification.permission === "denied"
          ? "bloqueado"
          : "perguntar",
      );
      if (pedirPermissao) toast.error(textoDoErroPush(erro));
    }
  }

  useEffect(() => {
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
    // A sessão é a única identidade relevante; o registro é idempotente por endpoint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessao?.usuario?.id]);

  function fecharAviso(): void {
    if (sessao) dispensarAviso(sessao.usuario.id);
    setEstado("indisponivel");
  }

  if (estado !== "perguntar") return null;

  return (
    <Dialog open onOpenChange={(aberto) => !aberto && fecharAviso()}>
      <DialogContent className="sm:max-w-md">
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
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button type="button" variant="ghost" onClick={fecharAviso} disabled={registrar.isPending}>
            Agora não
          </Button>
          <Button
            type="button"
            disabled={registrar.isPending}
            onClick={() => void sincronizar(true)}
          >
            <BellRing className="size-4" />
            Ativar notificações
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
