import { AppEnvironment } from "./env";
import type { AssinaturaWebPushBody } from "./api/alertas";

export function webPushDisponivel(): boolean {
  return (
    typeof window !== "undefined" &&
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

/** Obtém uma assinatura já autorizada ou pede permissão após um clique. */
export async function obterAssinaturaWebPush(
  pedirPermissao: boolean,
): Promise<PushSubscription | null> {
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
  if (!AppEnvironment.webPushPublicKey) {
    throw new Error("Notificações ainda não foram configuradas neste ambiente.");
  }
  return registro.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: chavePublicaBytes(AppEnvironment.webPushPublicKey),
  });
}

export function assinaturaParaApi(assinatura: PushSubscription): AssinaturaWebPushBody {
  const json = assinatura.toJSON();
  if (!json.endpoint || !json.keys?.["p256dh"] || !json.keys["auth"]) {
    throw new Error("O navegador devolveu uma assinatura de notificação incompleta.");
  }
  return {
    endpoint: json.endpoint,
    keys: {
      p256dh: json.keys["p256dh"],
      auth: json.keys["auth"],
    },
  };
}
