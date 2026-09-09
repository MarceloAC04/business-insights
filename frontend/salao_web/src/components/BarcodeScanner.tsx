import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { BrowserMultiFormatOneDReader } from "@zxing/browser";
import type { IScannerControls } from "@zxing/browser";
import { CameraOff, ScanLine } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Overlay de câmera para bipar código de barras (entrada de estoque).
 *
 * Só câmera do celular/notebook — sem leitor físico dedicado, é o que foi
 * pedido. Se a câmera não estiver disponível (permissão negada, sem
 * dispositivo), mostra o motivo em vez de travar a tela: ela ainda pode
 * fechar e cadastrar o item na mão pelo formulário normal.
 */

// Só os formatos usados em embalagem de produto — restringir ajuda o leitor a
// não perder tempo tentando reconhecer QR code/PDF417/etc. a cada quadro.
const FORMATOS_PRODUTO = [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93,
  BarcodeFormat.ITF,
];

const hints = new Map<DecodeHintType, unknown>();
hints.set(DecodeHintType.POSSIBLE_FORMATS, FORMATOS_PRODUTO);
hints.set(DecodeHintType.TRY_HARDER, true);

const OPCOES_LEITOR = {
  // Uma tentativa mais frequente faz diferença quando o código passa alguns
  // frames desfocado pela câmera, sem deixar o celular trabalhando sem pausa.
  delayBetweenScanAttempts: 120,
  delayBetweenScanSuccess: 300,
  tryPlayVideoTimeout: 10000,
};

type RecursosCamera = MediaTrackCapabilities & {
  focusMode?: string[];
  exposureMode?: string[];
  whiteBalanceMode?: string[];
};

export function BarcodeScannerDialog({
  open,
  onOpenChange,
  onDetectado,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDetectado: (codigo: string) => void;
}) {
  const controlsRef = useRef<IScannerControls | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  // O <video> vive dentro do Portal do Dialog (Radix só anexa o portal ao DOM
  // depois do primeiro commit, por causa de SSR). Um `ref` comum captura
  // `null` nesse primeiro efeito; um callback ref dispara re-render só quando
  // o nó realmente existe, então o efeito abaixo espera por ele em vez de
  // assumir que já está montado.
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [cameraPronta, setCameraPronta] = useState(false);

  const videoRef = useCallback((node: HTMLVideoElement | null) => {
    setVideo(node);
  }, []);

  useEffect(() => {
    if (!open || !video) return;
    setErro(null);
    setCameraPronta(false);
    let cancelado = false;
    const leitor = new BrowserMultiFormatOneDReader(hints, OPCOES_LEITOR);

    const iniciar = async () => {
      try {
        const controls = await leitor.decodeFromConstraints(
          {
            audio: false,
            video: {
              // `ideal` usa a câmera traseira no celular, mas não quebra em
              // notebook que só tem webcam frontal.
              facingMode: { ideal: "environment" },
              // Pede uma imagem grande sem exigir uma resolução mínima: alguns
              // aparelhos não entregam 1920x1080 e precisam de fallback próprio.
              width: { ideal: 1920 },
              height: { ideal: 1080 },
              frameRate: { ideal: 30 },
            },
          },
          video,
          (resultado) => {
            if (resultado && !cancelado) {
              cancelado = true;
              controlsRef.current?.stop();
              onDetectado(resultado.getText());
            }
          },
        );
        if (cancelado) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
        if (track) {
          const caps = track.getCapabilities?.() as RecursosCamera | undefined;
          const focoContinuo = caps?.focusMode?.includes("continuous");
          const exposicaoContinua = caps?.exposureMode?.includes("continuous");
          const balancoContinuo = caps?.whiteBalanceMode?.includes("continuous");
          const avancado: Record<string, string>[] = [];

          if (focoContinuo) avancado.push({ focusMode: "continuous" });
          if (exposicaoContinua) avancado.push({ exposureMode: "continuous" });
          if (balancoContinuo) avancado.push({ whiteBalanceMode: "continuous" });

          if (avancado.length > 0) {
            try {
              await track.applyConstraints({ advanced: avancado } as MediaTrackConstraints);
            } catch {
              // Alguns navegadores anunciam o recurso, mas recusam a aplicação.
              // A câmera continua funcionando com os ajustes automáticos padrão.
            }
          }
        }
        setCameraPronta(true);
      } catch (e: unknown) {
        const nome = e instanceof Error ? e.name : "";
        setErro(
          nome === "NotAllowedError"
            ? "Permissão de câmera negada. Permita o acesso e tente de novo."
            : nome === "NotFoundError"
              ? "Nenhuma câmera encontrada neste dispositivo."
              : "Não foi possível abrir a câmera.",
        );
      }
    };

    void iniciar();

    return () => {
      cancelado = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [open, video, onDetectado]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Bipar produto</DialogTitle>
          <DialogDescription>
            Deixe o código inteiro dentro da faixa, mantenha o celular firme e afaste um pouco se a
            imagem ficar desfocada.
          </DialogDescription>
        </DialogHeader>
        {erro ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-10 text-center">
            <CameraOff className="size-6 text-muted-foreground" />
            <p className="max-w-[80%] text-sm text-muted-foreground">{erro}</p>
          </div>
        ) : (
          <div className="relative overflow-hidden rounded-xl bg-black">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- vídeo é só o preview da câmera, sem áudio */}
            <video
              ref={videoRef}
              className="aspect-video w-full object-contain"
              // O modal centraliza com `translate(-50%,-50%)`; em alguns Android/Chrome um
              // <video> dentro de ancestral com `transform` renderiza preto até ganhar sua
              // própria camada de composição — isso força essa camada.
              style={{ transform: "translateZ(0)" }}
              muted
              autoPlay
              playsInline
            />
            <div className="pointer-events-none absolute inset-x-5 top-1/2 h-24 -translate-y-1/2 rounded-lg border-2 border-primary-foreground/80 shadow-[0_0_0_999px_rgba(0,0,0,0.2)]" />
            <ScanLine className="pointer-events-none absolute top-1/2 left-1/2 size-6 -translate-x-1/2 -translate-y-1/2 text-primary-foreground/70" />
          </div>
        )}
        {cameraPronta ? (
          <p className="text-center text-xs text-muted-foreground">
            Câmera pronta. Posicione as barras na horizontal dentro da faixa.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
