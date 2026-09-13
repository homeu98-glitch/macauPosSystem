"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { money2 } from "@/components/kiosk/order-summary-card";
import type { MemberPayMethod, MemberPayStage } from "@/lib/ledger/member-pay";

/**
 * 會員付款 bottom sheet —— 對應確認稿 S6 / S6T / S7 / S9。
 *
 * 四個 stage：
 *   - `choose`       付款方式（S6：餘額足夠 / S6b：餘額不足變灰但可見）
 *   - `deduct`       確認扣款（S7a 需 PIN / S7b 免 PIN）
 *   - `insufficient` Ledger 回 `insufficient_balance`（S9a：**訂單已保留**，可直接轉前台付）
 *   - `unknown`      網絡失敗、**結果未知**（S9b：唔當「未扣款」，用同一冪等鍵重試）
 *
 * 三條紅線：
 *   1. 🔴 **餘額不足唔可以「先扣餘額差額到前台補」** —— 會產生兩筆對帳。
 *      所以不足時「扣餘額」變灰但**保留可見**（要客人知「點解唔得 + 差幾多」），
 *      而同「非會員」唔同：非會員係**根本冇能力** → 直接隱藏（S4）。
 *   2. 🔴 **180 秒免 PIN 窗口係唯一防線** —— Ledger 端完全唔驗 PIN（契約 Q5），
 *      呢個閘判錯 = 等於冇二次確認。起計點 = **登入成功**，refresh 唔可延長。
 *   3. 🔴 **「結果未知」唔可以當「未扣款」** —— Ledger 冇 lookup API（Q6），
 *      查唔到 ≠ 冇扣。唯一手段 = 同一冪等鍵重試（回同一 txnId）。
 *      不確定就紅標交人，唔可以靜默當成功。
 */
export type PayOrderLine = { name: string; quantity: number; amountMop: number };

export function MemberPaySheet({
  t,
  variant = "mobile",
  stage,
  lines,
  totalMop,
  memberDisplayName,
  balanceMop,
  payMethod,
  busy,
  pinFreeAgoLabel,
  networkError,
  onSelectMethod,
  onConfirm,
  onConfirmWithPin,
  onCancelToCounter,
  onBackToChoose,
  onRetry,
  onGoCounter,
}: {
  t: (key: string) => string;
  variant?: "mobile" | "kiosk";
  stage: MemberPayStage;
  lines: PayOrderLine[];
  totalMop: number;
  memberDisplayName: string;
  /** 扣款前餘額（MOP）。 */
  balanceMop: number;
  payMethod: MemberPayMethod | null;
  busy: boolean;
  /** 免 PIN 時嘅「已登入多久」字串（例 `2 分 12 秒`）；null = 已逾 180 秒，需要再入 PIN。 */
  pinFreeAgoLabel: string | null;
  /** 網絡錯誤文案（`unknown` stage 用）。 */
  networkError: string | null;
  onSelectMethod: (method: MemberPayMethod) => void;
  onConfirm: () => void;
  onConfirmWithPin: (pin: string) => void;
  onCancelToCounter: () => void;
  onBackToChoose: () => void;
  onRetry: () => void;
  onGoCounter: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pin, setPin] = useState("");

  const isKiosk = variant === "kiosk";
  const balanceAfterMop = balanceMop - totalMop;
  const shortfallMop = totalMop - balanceMop;
  const insufficient = shortfallMop > 0;

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // ⚠️ `unknown` stage 刻意**唔准** Esc 關閉（確認稿 S9b：「請勿關閉此頁」）——
      //    閂咗就冇人知嗰筆扣款到底成功咗未。
      if (e.key === "Escape" && stage !== "unknown") onCancelToCounter();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancelToCounter, stage]);

  const keypadKey =
    "flex h-14 items-center justify-center rounded-xl bg-white text-2xl font-medium text-stone-800 " +
    "ring-1 ring-stone-200 active:scale-95 disabled:opacity-40";

  const rowClass = "flex items-center justify-between text-sm text-stone-600";

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={stage === "unknown" ? undefined : onCancelToCounter}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("payTitle")}
        className={`max-h-[92dvh] w-full overflow-y-auto rounded-3xl bg-white p-5 outline-none ${
          isKiosk ? "max-w-2xl" : "max-w-md"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── S9b：連線中斷 · 結果未知 ── */}
        {stage === "unknown" ? (
          <>
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-2xl">
                📡
              </div>
              <div>
                <h2 className="text-xl font-bold text-stone-900">{t("deductUnknownTitle")}</h2>
                <p className="text-sm text-stone-500">{t("deductUnknownSub")}</p>
              </div>
            </div>

            <div
              className="mb-4 rounded-2xl bg-amber-50 p-4"
              role="alert"
              aria-live="assertive"
            >
              <div className="mb-1 text-sm font-bold text-amber-800">⚠️ {t("deductUnknownBadge")}</div>
              <p className="text-xs leading-relaxed text-amber-800">
                {networkError ?? t("deductUnknownBody")}
              </p>
              <p className="mt-2 text-xs font-semibold text-amber-900">{t("deductUnknownKeep")}</p>
            </div>

            <p className="mb-4 text-xs text-stone-500">{t("deductUnknownHint")}</p>

            <button
              onClick={onRetry}
              disabled={busy}
              className={`w-full rounded-2xl bg-orange-500 font-semibold text-white disabled:opacity-50 active:scale-[0.98] ${
                isKiosk ? "py-5 text-xl" : "py-3.5 text-lg"
              }`}
            >
              {busy ? t("submitting") : t("deductRetry")}
            </button>
            <button
              onClick={onGoCounter}
              disabled={busy}
              className="mt-2.5 w-full rounded-2xl border border-stone-200 py-3 font-semibold text-stone-600 disabled:opacity-50 active:scale-[0.98]"
            >
              {t("deductGoCounter")}
            </button>
          </>
        ) : stage === "insufficient" ? (
          /* ── S9a：餘額不足（確認扣款之後才發現）── */
          <>
            <h2 className="mb-4 text-xl font-bold text-stone-900">
              💳 {t("payInsufficientTitle")}
            </h2>

            <div className="mb-4 rounded-2xl bg-stone-50 p-4">
              <div className={`${rowClass} mb-1.5`}>
                <span>{t("memberBalanceLabel")}</span>
                <span className="font-semibold text-stone-900">MOP {money2(balanceMop)}</span>
              </div>
              <div className={rowClass}>
                <span>{t("payAmountLabel")}</span>
                <span className="font-semibold text-stone-900">MOP {money2(totalMop)}</span>
              </div>
            </div>

            <div className="mb-4 rounded-2xl bg-emerald-50 p-4">
              <div className="mb-1 text-sm font-semibold text-emerald-800">
                {t("payInsufficientKept")}
              </div>
              <p className="text-xs leading-relaxed text-emerald-800">
                {t("payInsufficientKeptBody")}
              </p>
            </div>

            <button
              onClick={onCancelToCounter}
              className={`w-full rounded-2xl bg-orange-500 font-semibold text-white active:scale-[0.98] ${
                isKiosk ? "py-5 text-xl" : "py-3.5 text-lg"
              }`}
            >
              {t("payBackToCounter")}
            </button>
            <button
              onClick={onBackToChoose}
              className="mt-2.5 w-full rounded-2xl border border-stone-200 py-3 font-semibold text-stone-600 active:scale-[0.98]"
            >
              {t("payChooseAgain")}
            </button>
          </>
        ) : stage === "deduct" ? (
          /* ── S7：確認扣款（需 PIN / 免 PIN）── */
          <>
            <h2 className="mb-4 text-xl font-bold text-stone-900">{t("deductTitle")}</h2>

            <div className="mb-4 rounded-2xl bg-stone-50 p-4">
              <div className={`${rowClass} mb-1.5`}>
                <span>{t("deductAmountLabel")}</span>
                <span className="text-lg font-bold text-orange-600">MOP {money2(totalMop)}</span>
              </div>
              <div className={`${rowClass} mb-1.5`}>
                <span>{t("deductMemberLabel")}</span>
                <span className="font-semibold text-stone-900">{memberDisplayName}</span>
              </div>
              <div className={`${rowClass} mb-1.5`}>
                <span>{t("deductBalanceBefore")}</span>
                <span className="text-stone-900">MOP {money2(balanceMop)}</span>
              </div>
              <div className={rowClass}>
                <span>{t("deductBalanceAfter")}</span>
                <span className="font-semibold text-stone-900">MOP {money2(balanceAfterMop)}</span>
              </div>
            </div>

            {pinFreeAgoLabel ? (
              <div className="mb-4 flex items-start gap-2.5 rounded-2xl bg-emerald-50 p-4">
                <span className="text-lg">✓</span>
                <div>
                  <div className="text-sm font-semibold text-emerald-800">{t("deductPinFree")}</div>
                  <p className="mt-0.5 text-xs text-emerald-700">
                    {t("deductPinFreeHint").replace("{ago}", pinFreeAgoLabel)}
                  </p>
                  <p className="mt-1 text-[11px] text-emerald-600">{t("deductPinFreeGuard")}</p>
                </div>
              </div>
            ) : (
              <div className="mb-4">
                <div className="mb-2 text-sm font-medium text-stone-600">{t("deductNeedPin")}</div>
                {isKiosk ? (
                  <>
                    <div className="mb-3 flex h-14 items-center justify-center rounded-xl border-2 border-orange-500 tracking-[0.3em]">
                      <span className="text-2xl">{pin.length > 0 ? "•".repeat(pin.length) : "\u00A0"}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2.5">
                      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setPin((p) => (p.length >= 4 ? p : p + d))}
                          disabled={busy}
                          className={keypadKey}
                        >
                          {d}
                        </button>
                      ))}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setPin("")}
                        className={keypadKey}
                        aria-label="清除"
                      >
                        C
                      </button>
                      <button
                        type="button"
                        onClick={() => setPin((p) => (p.length >= 4 ? p : p + "0"))}
                        disabled={busy}
                        className={keypadKey}
                      >
                        0
                      </button>
                      <button
                        type="button"
                        onClick={() => setPin((p) => p.slice(0, -1))}
                        disabled={busy}
                        className={keypadKey}
                        aria-label="刪除"
                      >
                        ⌫
                      </button>
                    </div>
                  </>
                ) : (
                  <input
                    // 🔴 同 `member-login-sheet` 一樣：`type="password"` 會令 **iOS 無視
                    //    `inputMode`** 彈字母鍵盤 → 客人打唔到 PIN。用 text + inputMode + 遮蔽。
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="off"
                    maxLength={4}
                    value={pin}
                    style={{ WebkitTextSecurity: "disc" } as CSSProperties}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && pin.length === 4 && !busy) onConfirmWithPin(pin);
                    }}
                    aria-label={t("deductNeedPin")}
                    className="h-14 w-full rounded-xl border-2 border-orange-500 px-4 text-center text-xl tracking-[0.3em] outline-none"
                  />
                )}
              </div>
            )}

            <button
              onClick={() => (pinFreeAgoLabel ? onConfirm() : onConfirmWithPin(pin))}
              disabled={busy || (!pinFreeAgoLabel && pin.length !== 4)}
              className={`w-full rounded-2xl bg-orange-500 font-semibold text-white disabled:opacity-50 active:scale-[0.98] ${
                isKiosk ? "py-5 text-xl" : "py-3.5 text-lg"
              }`}
            >
              {busy ? t("submitting") : t("deductConfirm")}
            </button>
            <button
              onClick={onCancelToCounter}
              disabled={busy}
              className="mt-2.5 w-full rounded-2xl border border-stone-200 py-3 font-semibold text-stone-600 disabled:opacity-50 active:scale-[0.98]"
            >
              {t("deductCancelToCounter")}
            </button>
          </>
        ) : (
          /* ── S6 / S6T：付款方式 ── */
          <>
            <h2 className="mb-4 text-xl font-bold text-stone-900">{t("payTitle")}</h2>

            <div className="mb-3 space-y-1.5">
              {lines.map((line) => (
                <div key={`${line.name}-${line.quantity}-${line.amountMop}`} className={rowClass}>
                  <span className="truncate">
                    {line.name} × {line.quantity}
                  </span>
                  <span className="shrink-0 text-stone-900">{money2(line.amountMop)}</span>
                </div>
              ))}
            </div>

            <div className="mb-4 flex items-center justify-between border-t border-stone-200 pt-3">
              <span className="text-sm font-medium text-stone-600">{t("payAmountLabel")}</span>
              <span className="text-lg font-bold text-stone-900">MOP {money2(totalMop)}</span>
            </div>

            <div className="mb-3 text-sm font-medium text-stone-600">{t("payTitle")}</div>

            {/* 扣餘額：不足時**變灰但保留可見**（要見到「點解唔得」+ 差幾多） */}
            <button
              type="button"
              onClick={() => onSelectMethod("balance")}
              disabled={insufficient || busy}
              aria-pressed={payMethod === "balance"}
              className={`mb-2.5 w-full rounded-2xl border-2 p-4 text-left transition disabled:opacity-70 ${
                payMethod === "balance" && !insufficient
                  ? "border-orange-500 bg-orange-50"
                  : "border-stone-200 bg-white"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">💳</span>
                <span className="font-semibold text-stone-900">{t("payOptionBalance")}</span>
              </div>
              <div className="mt-1 text-xs text-stone-500">
                {insufficient
                  ? t("payInsufficientShort").replace("{short}", `MOP ${money2(shortfallMop)}`)
                  : t("payBalanceAfter")
                      .replace("{balance}", `MOP ${money2(balanceMop)}`)
                      .replace("{after}", `MOP ${money2(balanceAfterMop)}`)}
              </div>
            </button>

            <button
              type="button"
              onClick={() => onSelectMethod("counter")}
              disabled={busy}
              aria-pressed={payMethod === "counter"}
              className={`w-full rounded-2xl border-2 p-4 text-left transition ${
                payMethod === "counter" ? "border-orange-500 bg-orange-50" : "border-stone-200 bg-white"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🏪</span>
                <span className="font-semibold text-stone-900">{t("payOptionCounter")}</span>
              </div>
              <div className="mt-1 text-xs text-stone-500">{t("payOptionCounterHint")}</div>
            </button>

            {insufficient && (
              <p className="mt-2.5 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
                💡 {t("payNoPartialHint")}
              </p>
            )}

            <div aria-live="assertive" role="alert">
              {networkError && stage === "choose" && (
                <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">
                  {networkError}
                </div>
              )}
            </div>

            <button
              onClick={onConfirm}
              disabled={busy || !payMethod || (payMethod === "balance" && insufficient)}
              className={`mt-4 w-full rounded-2xl bg-orange-500 font-semibold text-white disabled:opacity-50 active:scale-[0.98] ${
                isKiosk ? "py-5 text-xl" : "py-3.5 text-lg"
              }`}
            >
              {busy
                ? t("submitting")
                : `${t("payConfirm")} · ${
                    payMethod === "balance" && !insufficient
                      ? `MOP ${money2(totalMop)}`
                      : t("payOptionCounter")
                  }`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
