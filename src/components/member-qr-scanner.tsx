"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 共用 QR 掃碼層（支付頁結帳「會員」／會員頁都用同一個）。
 *
 * 2026-11-05：POS 原本零鏡頭掃碼能力。呢個元件：
 *  - 瀏覽器原生 `BarcodeDetector` 優先（Android / Chrome）；
 *  - iOS Safari 冇 BarcodeDetector ⇒ 動態載入 `/vendor/jsQR.js`（UMD 會設 `window.jsQR`），
 *    canvas 降採樣到 360px 逐幀解碼，唔好將 1280×720 全幀直接交畀 jsQR（會卡頓）。
 *  - 必须 HTTPS（getUserMedia 喺非安全連線係 undefined），權限被拒要有手動輸入後備。
 *
 * 🔴 一個掃碼掣認兩類碼，但**分流唔喺呢度做**：呢個元件只負責「交出掃到嘅字串」，
 *    由呼叫端經 `lib/ledger/member-qr-client.ts` 順序探測（會員碼 → 券碼）。
 *
 * 生命週期守衛（`open` 以外唔重開相機）：
 *  - `onResultRef` 避免 effect 因 callback identity 改變而不斷 subscribe／開關鏡頭；
 *  - 所有 async 回來先判 `cancelled` 先至用 stream；
 *  - cleanup 一定停 tracks + cancelAnimationFrame，PWA 切背景唔殘留鏡頭。
 */

type DetectedCode = { rawValue?: string; data?: string };
type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<DetectedCode[]>;
};
type BarcodeDetectorCtor = {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
};
/** 沿用 `print-bridge/hub.ts` 已有嘅全域宣告，唔好再宣告一次（TS2717）。 */
type JsQrFn = NonNullable<Window["jsQR"]>;

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorCtor;
  }
}

let jsQrLoadPromise: Promise<JsQrFn | null> | null = null;

/** 由同 origin 的 public 載入 jsQR（唔經 npm、唔經 bundler，PWA 離線都讀到）。 */
function loadJsQr(): Promise<JsQrFn | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (typeof window.jsQR === "function") return Promise.resolve(window.jsQR);
  if (jsQrLoadPromise) return jsQrLoadPromise;

  jsQrLoadPromise = new Promise<JsQrFn | null>((resolve) => {
    const script = document.createElement("script");
    script.src = "/vendor/jsQR.js";
    script.async = true;
    script.dataset.posJsqr = "1";
    script.onload = () => {
      const fn = typeof window.jsQR === "function" ? window.jsQR : null;
      if (!fn) jsQrLoadPromise = null;
      resolve(fn);
    };
    script.onerror = () => {
      // 載入失敗唔好 cache 住一個永遠 null 嘅 promise（轉返網絡後要重試到）。
      jsQrLoadPromise = null;
      resolve(null);
    };
    document.head.appendChild(script);
  });

  return jsQrLoadPromise;
}

const DOWNSAMPLE = 360;
const SCAN_INTERVAL_MS = 110;

export type MemberQrScannerProps = {
  open: boolean;
  title: string;
  hint: string;
  /** 掃到／手動輸入嘅原始字串。呼叫端負責分類，唔好喺呢度判。 */
  onResult: (value: string) => void;
  onClose: () => void;
  /** false = 只認會員碼（支付頁）；true = 顯示「會員碼或優惠券」提示（會員頁）。 */
  allowCoupon?: boolean;
};

export function MemberQrScanner({
  open,
  title,
  hint,
  onResult,
  onClose,
  allowCoupon = false,
}: MemberQrScannerProps) {
  const [status, setStatus] = useState<"starting" | "scanning" | "error">("starting");
  const [errorMessage, setErrorMessage] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onResultRef = useRef(onResult);
  const handledRef = useRef(false);

  onResultRef.current = onResult;

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    let rafId = 0;
    let stream: MediaStream | null = null;
    let detector: BarcodeDetectorLike | null = null;
    let jsQr: JsQrFn | null = null;
    let lastScanAt = 0;

    handledRef.current = false;
    setStatus("starting");
    setErrorMessage("");
    setManualOpen(false);
    setManualValue("");

    const stopStream = () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };

    const emit = (value: string) => {
      if (cancelled || handledRef.current) return;
      const trimmed = value.trim();
      if (!trimmed) return;
      handledRef.current = true;
      cancelAnimationFrame(rafId);
      stopStream();
      onResultRef.current(trimmed);
    };

    const scanFrame = (now: number) => {
      if (cancelled || handledRef.current) return;
      rafId = window.requestAnimationFrame(scanFrame);
      if (now - lastScanAt < SCAN_INTERVAL_MS) return;
      lastScanAt = now;

      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;

      if (detector) {
        void detector.detect(video).then((codes) => {
          if (cancelled) return;
          const value = codes[0]?.rawValue ?? codes[0]?.data;
          if (value) emit(value);
        }).catch(() => undefined);
        return;
      }

      if (!jsQr) return;
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, DOWNSAMPLE / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, width, height);
      const result = jsQr(ctx.getImageData(0, 0, width, height).data, width, height, {
        inversionAttempts: "dontInvert",
      });
      if (result?.data) emit(result.data);
    };

    const start = async () => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        const insecure = typeof window !== "undefined" && window.isSecureContext === false;
        setStatus("error");
        setErrorMessage(
          insecure
            ? "相機需要 HTTPS 安全連線。請改用 HTTPS 網址，或用手動輸入。"
            : "此瀏覽器不支援相機，請改用手動輸入。",
        );
        return;
      }

      const Ctor = window.BarcodeDetector;
      if (Ctor) {
        try {
          const formats = (await Ctor.getSupportedFormats?.()) ?? ["qr_code"];
          if (formats.includes("qr_code")) detector = new Ctor({ formats: ["qr_code"] });
        } catch {
          detector = null;
        }
      }
      if (cancelled) return;

      if (!detector) {
        jsQr = await loadJsQr();
        if (cancelled) return;
        if (!jsQr) {
          setStatus("error");
          setErrorMessage("無法載入掃碼元件，請重新整理或用手動輸入。");
          return;
        }
      }

      try {
        const media = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        // async 回來先判 cancelled（元件可能已被關閉）。
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        const video = videoRef.current;
        if (!video) {
          stopStream();
          return;
        }
        video.srcObject = media;
        video.setAttribute("playsinline", "true");
        await video.play().catch(() => undefined);
        if (cancelled) {
          stopStream();
          return;
        }
        setStatus("scanning");
        rafId = window.requestAnimationFrame(scanFrame);
      } catch {
        if (cancelled) return;
        setStatus("error");
        setErrorMessage("無法開啟相機，請確認已授權相機權限，或改用手動輸入。");
      }
    };

    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      stopStream();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function emitManual() {
    const value = manualValue.trim();
    if (!value || handledRef.current) return;
    handledRef.current = true;
    onResultRef.current(value);
  }

  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-slate-950 text-white">
      <div className="flex min-h-[72px] shrink-0 items-center justify-between gap-4 border-b border-white/10 px-6 py-3">
        <div className="min-w-0">
          <div className="truncate text-lg font-semibold">{title}</div>
          <div className="mt-0.5 text-xs text-slate-400">
            {allowCoupon ? "會員碼 → 認會員；優惠券 QR → 確認後核銷" : "iPad 後置鏡頭 · 只認會員碼"}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="h-11 min-w-[88px] shrink-0 rounded-2xl border border-white/20 bg-white/10 px-4 text-sm font-semibold hover:bg-white/20"
        >
          關閉
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6 py-4">
        <div className="relative h-[min(42vh,360px)] w-[min(42vh,360px)] overflow-hidden rounded-3xl bg-slate-900">
          <video
            ref={videoRef}
            className="h-full w-full object-cover"
            muted
            playsInline
            autoPlay
          />
          <span className="pointer-events-none absolute left-5 top-5 h-11 w-11 rounded-tl-xl border-l-4 border-t-4 border-orange-500" />
          <span className="pointer-events-none absolute right-5 top-5 h-11 w-11 rounded-tr-xl border-r-4 border-t-4 border-orange-500" />
          <span className="pointer-events-none absolute bottom-5 left-5 h-11 w-11 rounded-bl-xl border-b-4 border-l-4 border-orange-500" />
          <span className="pointer-events-none absolute bottom-5 right-5 h-11 w-11 rounded-br-xl border-b-4 border-r-4 border-orange-500" />
          {status === "scanning" ? (
            <span className="pos-qr-scanline pointer-events-none absolute left-6 right-6 h-[3px] rounded bg-orange-500" />
          ) : null}
        </div>

        {status === "starting" ? (
          <p className="text-center text-sm text-slate-300">正在開啟相機…</p>
        ) : null}
        {status === "error" ? (
          <p className="max-w-xl rounded-2xl bg-rose-500/15 px-4 py-3 text-center text-sm text-rose-200">
            {errorMessage}
          </p>
        ) : null}
        <p className="max-w-xl text-center text-sm leading-relaxed text-slate-300">{hint}</p>

        {manualOpen ? (
          <div className="flex w-full max-w-xl flex-wrap items-center justify-center gap-2">
            <input
              className="h-11 min-w-[220px] flex-1 rounded-2xl border border-white/20 bg-white/10 px-4 text-base text-white placeholder:text-slate-400"
              placeholder="輸入會員碼或優惠券碼"
              value={manualValue}
              onChange={(event) => setManualValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") emitManual();
              }}
            />
            <button
              type="button"
              onClick={emitManual}
              className="h-11 min-w-[96px] rounded-2xl bg-orange-500 px-4 text-sm font-semibold hover:bg-orange-600"
            >
              確定
            </button>
          </div>
        ) : null}
      </div>

      <div className="flex min-h-[92px] shrink-0 flex-wrap items-center justify-center gap-3 border-t border-white/10 px-6 py-4">
        <button
          type="button"
          onClick={() => setManualOpen((prev) => !prev)}
          className="h-11 min-w-[150px] rounded-2xl border border-white/20 bg-white/10 px-4 text-sm font-semibold hover:bg-white/20"
        >
          {manualOpen ? "收起手動輸入" : "手動輸入碼"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-11 min-w-[150px] rounded-2xl bg-orange-500 px-4 text-sm font-semibold hover:bg-orange-600"
        >
          取消
        </button>
        <span className="text-xs text-slate-500">需要 HTTPS + 相機權限</span>
      </div>
    </div>
  );
}
