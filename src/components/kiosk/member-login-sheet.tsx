"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

/**
 * 會員登入 bottom sheet —— **Kiosk 平板同手機掃碼共用**（同 `SpecSheet` 一樣嘅共用模式）。
 *
 * 對應確認稿 S2（手機）/ S2T（平板）/ S3a（失敗）/ S3b（鎖定）。
 *
 * 兩條紅線：
 *   1. 🔴 **PIN 唔經前端運算** —— 元件只原樣收集，唔 hash、唔比對、唔存。
 *      真正驗證喺 `POST /api/ledger/member-login`（server 側派生密碼，契約 §4.5.1）。
 *   2. 🔴 **一定要有逃生門** —— 「跳過，直接點餐」同鎖定頁嘅「改用非會員，直接點餐」。
 *      冇嘅話客人喺繁忙時段就係死局（唔可以逼人登入）。
 *
 * @param variant `mobile`（系統鍵盤）| `kiosk`（螢幕數字鍵盤，唔用系統鍵盤）
 *   —— 自助機用系統鍵盤會留低輸入法狀態、亦怕被切換輸入法，所以平板走自繪鍵盤。
 */
export function MemberLoginSheet({
  t,
  variant = "mobile",
  submitting,
  errorMessage,
  remainingAttempts,
  lockedRetryAt,
  onClose,
  onSkip,
  onSubmit,
}: {
  t: (key: string) => string;
  variant?: "mobile" | "kiosk";
  submitting: boolean;
  /** 上次嘗試嘅失敗文案（`bad_credential` / 網絡問題）。null = 未試過。 */
  errorMessage: string | null;
  /** 剩餘嘗試次數（null = 未失敗過）。0 = 已鎖。 */
  remainingAttempts: number | null;
  /** 已鎖定時嘅解鎖時間字串（例 `14:37`）；null = 未鎖。 */
  lockedRetryAt: string | null;
  onClose: () => void;
  onSkip: () => void;
  onSubmit: (phone: string, pin: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [field, setField] = useState<"phone" | "pin">("phone");

  const locked = Boolean(lockedRetryAt);
  const ready = phone.length === 8 && pin.length === 4;

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 帳號滿 8 位自動跳去 PIN —— 自助機少按一次「下一格」，亦避免客人以為要自己撳。
  useEffect(() => {
    if (phone.length >= 8) setField("pin");
  }, [phone.length]);

  const isKiosk = variant === "kiosk";

  function press(digit: string) {
    if (locked || submitting) return;
    if (field === "phone") {
      setPhone((prev) => (prev.length >= 8 ? prev : prev + digit));
      return;
    }
    setPin((prev) => (prev.length >= 4 ? prev : prev + digit));
  }

  function backspace() {
    if (locked || submitting) return;
    if (field === "pin") {
      if (pin.length === 0) {
        setField("phone");
        return;
      }
      setPin((prev) => prev.slice(0, -1));
      return;
    }
    setPhone((prev) => prev.slice(0, -1));
  }

  const fieldClass = (name: "phone" | "pin") =>
    `flex w-full items-center justify-between rounded-xl border-2 px-4 ${
      isKiosk ? "h-16" : "h-14"
    } text-left ${
      locked
        ? "border-stone-200 bg-stone-100 text-stone-400"
        : name === field
          ? "border-orange-500 bg-white"
          : "border-stone-200 bg-white"
    }`;

  const keypadKey =
    "flex h-14 items-center justify-center rounded-xl bg-white text-2xl font-medium text-stone-800 " +
    "ring-1 ring-stone-200 active:scale-95 disabled:opacity-40";

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("memberLoginTitle")}
        className={`max-h-[92dvh] w-full overflow-y-auto rounded-3xl bg-white p-5 outline-none ${
          isKiosk ? "max-w-2xl" : "max-w-md"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {locked ? (
          /* ── S3b：帳號已暫時鎖定 ── */
          <>
            <div className={`flex flex-col items-center text-center ${isKiosk ? "py-6" : "py-4"}`}>
              <div
                className={`mb-4 flex items-center justify-center rounded-full bg-red-100 ${
                  isKiosk ? "h-20 w-20 text-4xl" : "h-16 w-16 text-3xl"
                }`}
              >
                🔒
              </div>
              <h2 className={`mb-1 font-bold text-stone-900 ${isKiosk ? "text-2xl" : "text-xl"}`}>
                {t("memberLockedTitle")}
              </h2>
              <p className="mb-1 text-sm text-stone-500">{t("memberLockedReason")}</p>
              <p className="mb-5 text-base font-semibold text-red-600">
                {t("memberLockedRetryAt").replace("{time}", lockedRetryAt ?? "")}
              </p>

              <div className="mb-5 w-full rounded-2xl bg-stone-50 p-4 text-left">
                <div className="mb-1 text-sm font-semibold text-stone-800">
                  {t("memberStillCanOrder")}
                </div>
                <p className="text-xs leading-relaxed text-stone-500">{t("memberLockedExplain")}</p>
              </div>

              {/* 🔴 唯一出路：唔可以令客人卡死喺呢一頁 */}
              <button
                onClick={onSkip}
                className={`w-full rounded-2xl bg-orange-500 font-semibold text-white active:scale-[0.98] ${
                  isKiosk ? "py-5 text-xl" : "py-3.5 text-lg"
                }`}
              >
                {t("memberSwitchToGuest")}
              </button>
            </div>
          </>
        ) : (
          /* ── S2 / S2T：帳號 + PIN ── */
          <>
            <h2 className={`mb-1 font-bold text-stone-900 ${isKiosk ? "text-2xl" : "text-xl"}`}>
              {t("memberLoginTitle")}
            </h2>
            <p className="mb-5 text-sm text-stone-500">{t("memberLoginSubtitle")}</p>

            {/* ── 會員帳號（手機號碼）──
                🔴 手機版一定要用**真 `<input>`** —— 之前兩個 variant 都用 `<button>` 顯示，
                   結果手機完全冇輸入方式（撳極都唔會彈系統鍵盤），客人無法輸入。
                   Kiosk 才用 `<button>` + 自繪螢幕鍵盤（自助機唔用系統鍵盤）。 */}
            <div className="mb-3">
              <div className="mb-1.5 text-sm font-medium text-stone-600">{t("memberPhoneLabel")}</div>
              {isKiosk ? (
                <button
                  type="button"
                  onClick={() => setField("phone")}
                  className={fieldClass("phone")}
                  aria-label={t("memberPhoneLabel")}
                >
                  <span className="text-2xl tracking-[0.2em]">{phone || "\u00A0"}</span>
                  <span className="text-xs text-stone-400">{phone.length}/8</span>
                </button>
              ) : (
                <input
                  type="tel"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="tel"
                  maxLength={8}
                  value={phone}
                  // 只准數字：`replace(/\D/g,"")` 處理貼上 / 非數字鍵盤輸入；
                  // 裁到 8 位即係「後 8 位」語義（契約 §4.5.1 `/^\d{8}$/`）。
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 8))}
                  placeholder="8 位數字"
                  aria-label={t("memberPhoneLabel")}
                  className="h-14 w-full rounded-xl border-2 border-stone-200 bg-white px-4 text-xl tracking-[0.2em] text-stone-900 outline-none focus:border-orange-500"
                />
              )}
            </div>

            {/* ── PIN（4 位數字）── */}
            <div className="mb-4">
              <div className="mb-1.5 text-sm font-medium text-stone-600">{t("memberPinLabel")}</div>
              {isKiosk ? (
                <button
                  type="button"
                  onClick={() => setField("pin")}
                  className={fieldClass("pin")}
                  aria-label={t("memberPinLabel")}
                >
                  <span className="text-2xl tracking-[0.3em]">
                    {pin.length > 0 ? "•".repeat(pin.length) : "\u00A0"}
                  </span>
                  <span className="text-xs text-stone-400">{pin.length}/4</span>
                </button>
              ) : (
                <input
                  // 🔴 唔可以用 `type="password"`：**iOS Safari 會無視 `inputMode`** 直接彈字母鍵盤
                  //    → 客人打唔到 PIN。改用 `type="text"` + `inputMode="numeric"`，
                  //    再用 `-webkit-text-security: disc` 做遮蔽（iOS / Android 都支援）。
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  maxLength={4}
                  value={pin}
                  style={{ WebkitTextSecurity: "disc" } as CSSProperties}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  // 手機用系統鍵盤 → 畀客人撳「完成 / 前往」直接送出（唔使特登搵落單掣）。
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && ready && !submitting) onSubmit(phone, pin);
                  }}
                  placeholder="4 位數字"
                  aria-label={t("memberPinLabel")}
                  className="h-14 w-full rounded-xl border-2 border-stone-200 bg-white px-4 text-xl tracking-[0.3em] text-stone-900 outline-none focus:border-orange-500"
                />
              )}
            </div>

            {/* 失敗態（S3a）：紅框 + 剩餘次數。⚠️ 唔顯示「已錯幾個字元」—— 嗰個係枚舉線索。 */}
            <div aria-live="assertive" role="alert">
              {errorMessage && (
                <div className="mb-3 rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-600">
                  <div className="font-semibold">⛔ {errorMessage}</div>
                  {remainingAttempts !== null && remainingAttempts > 0 && (
                    <div className="mt-0.5 text-xs">
                      {t("memberRemainingAttempts").replace("{n}", String(remainingAttempts))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 平板專屬：螢幕數字鍵盤 */}
            {isKiosk && (
              <div className="mb-4 grid grid-cols-3 gap-2.5">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => press(d)}
                    disabled={submitting}
                    className={keypadKey}
                  >
                    {d}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setField(field === "phone" ? "pin" : "phone")}
                  disabled={submitting}
                  className={`${keypadKey} text-base`}
                >
                  {field === "phone" ? "PIN" : "帳號"}
                </button>
                <button
                  type="button"
                  onClick={() => press("0")}
                  disabled={submitting}
                  className={keypadKey}
                >
                  0
                </button>
                <button
                  type="button"
                  onClick={backspace}
                  disabled={submitting}
                  className={keypadKey}
                  aria-label="刪除"
                >
                  ⌫
                </button>
              </div>
            )}

            <button
              onClick={() => onSubmit(phone, pin)}
              disabled={!ready || submitting}
              className={`w-full rounded-2xl bg-orange-500 font-semibold text-white disabled:opacity-50 active:scale-[0.98] ${
                isKiosk ? "py-5 text-xl" : "py-3.5 text-lg"
              }`}
            >
              {submitting ? t("submitting") : t("memberLoginSubmit")}
            </button>

            {/* 🔴 逃生門：唔可以逼人登入 */}
            <button
              onClick={onSkip}
              disabled={submitting}
              className="mt-2.5 w-full rounded-2xl border border-stone-200 py-3 font-semibold text-stone-600 active:scale-[0.98] disabled:opacity-50"
            >
              {t("memberLoginSkip")}
            </button>

            <div className="mt-4 space-y-1 text-center">
              <p className="text-xs text-stone-400">{t("memberPinIssuedHint")}</p>
              <p className="text-xs text-amber-600">{t("memberLockWarning")}</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
