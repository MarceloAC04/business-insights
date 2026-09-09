import { AppEnvironment } from "./env";
import type { AssinaturaWebPushBody } from "./api/alertas";
import { ApiError } from "./error-codes";

class WebPushError extends Error {}

/** Falhas do navegador não devem aparecer como mensagens técnicas em inglês. */
export function textoDoErroPush(erro: unknown): string {
  if (erro instanceof ApiError) return erro.texto;
  if (erro instanceof WebPushError) return erro.message;
  if (erro instanceof Error) {
    switch (erro.name) {
      case "NotAllowedError":
        return "O navegador bloqueou as notificações. Libere a permissão deste site nas configurações do navegador e tente novamente.";
      case "AbortError":
      case "NetworkError":
        return "O serviço de notificações do navegador não respondeu. Tente novamente. Se estiver usando o navegador dentro de outro aplicativo, abra este link diretamente no Chrome ou Edge.";
      case "InvalidStateError":
        return "O navegador não conseguiu preparar as notificações. Feche e abra novamente o navegador e tente de novo.";
      case "NotSupportedError":
        return "Este navegador não conseguiu ativar as notificações. Abra o app em um navegador atualizado, como Chrome ou Edge.";
      case "InvalidAccessError":
      case "InvalidCharacterError":
        return "A configuração das notificações está inválida. Atualize a página e tente novamente.";
    }
  }
  return "Não foi possível ativar as notificações neste navegador. Tente novamente em instantes.";
}

export function webPushDisponivel(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

async function registroServiceWorker(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/push-sw.js", { scope: "/" });
  // No primeiro uso o registro ainda pode estar instalando. Só é seguro criar
  // a assinatura depois que o navegador informar um worker ativo.
  return navigator.serviceWorker.ready;
}

function chavePublicaBytes(chave: string): ArrayBuffer {
  const preenchida = `${chave}${"=".repeat((4 - (chave.length % 4)) % 4)}`
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const binario = window.atob(preenchida);
  return Uint8Array.from(binario, (caractere) => caractere.charCodeAt(0)).buffer as ArrayBuffer;
}

let assinaturaEmAndamento: Promise<PushSubscription | null> | null = null;

/** Compartilha a tentativa enquanto o serviço do navegador ainda está respondendo. */
export function obterAssinaturaWebPush(pedirPermissao: boolean): Promise<PushSubscription | null> {
  if (assinaturaEmAndamento) return assinaturaEmAndamento;
  assinaturaEmAndamento = prepararAssinatura(pedirPermissao).finally(() => {
    assinaturaEmAndamento = null;
  });
  return assinaturaEmAndamento;
}

async function prepararAssinatura(pedirPermissao: boolean): Promise<PushSubscription | null> {
  if (!webPushDisponivel()) return null;

  if (Notification.permission === "default") {
    if (!pedirPermissao) return null;
    const permissao = await Notification.requestPermission();
    if (permissao !== "granted") return null;
  }
  if (Notification.permission !== "granted") return null;

  const registro = await registroServiceWorker();
  const atual = await registro.pushManager.getSubscription();
  if (atual) return atual;
  // Ao entrar no app, só sincroniza inscrições existentes. Uma nova inscrição
  // precisa partir do botão, mesmo quando a permissão já foi concedida.
  if (!pedirPermissao) return null;
  if (!AppEnvironment.webPushPublicKey) {
    throw new WebPushError("Notificações ainda não foram configuradas neste ambiente.");
  }
  return registro.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: chavePublicaBytes(AppEnvironment.webPushPublicKey),
  });
}

export function assinaturaParaApi(assinatura: PushSubscription): AssinaturaWebPushBody {
  const json = assinatura.toJSON();
  if (!json.endpoint || !json.keys?.["p256dh"] || !json.keys["auth"]) {
    throw new WebPushError(
      "O navegador não concluiu a ativação das notificações. Tente novamente.",
    );
  }
  return {
    endpoint: json.endpoint,
    keys: {
      p256dh: json.keys["p256dh"],
      auth: json.keys["auth"],
    },
  };
}
