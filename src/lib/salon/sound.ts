// Salon 提示音（WebAudio 合成，唔依賴外部音檔）
//
// SSR / 受限瀏覽器 / 靜音環境下全部靜默降級，絕不拋錯。
// 接線點：結帳成功、收據列印成功 / 失敗。

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

function beep(freq: number, durationMs: number, type: OscillatorType = "sine", gain = 0.04) {
  if (typeof window === "undefined") return;
  const audio = getCtx();
  if (!audio) return;
  try {
    if (audio.state === "suspended") void audio.resume();
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.value = gain;
    osc.connect(g);
    g.connect(audio.destination);
    const now = audio.currentTime;
    osc.start(now);
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
    osc.stop(now + durationMs / 1000);
  } catch {
    // ignore audio failures (autoplay policy / no device)
  }
}

/** 成功：兩聲上行短 beep */
export function playSuccessBeep() {
  beep(660, 120);
  if (typeof window !== "undefined") {
    window.setTimeout(() => beep(880, 160), 130);
  }
}

/** 失敗：低沉方波 */
export function playErrorBeep() {
  beep(220, 260, "square", 0.05);
}
