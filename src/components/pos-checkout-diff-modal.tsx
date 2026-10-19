"use client";

import { useState } from "react";

import { useT } from "@/components/lang-provider";
import { formatMoney } from "@/lib/format";
import { ResponsiveModal } from "@/components/responsive-modal";
import { maskPhoneForReceipt } from "@/lib/pos/checkout-diff";

/** 差額處理方式（mockup v3 畫面 ⑤ 三選項）。 */
export type CheckoutDiffOption = "topup" | "cash" | "none";

export type PosCheckoutDiffModalProps = {
  /** 單號（例：A05） */
  orderCode: string;
  /** 顧客顯示名（可空） */
  customerName?: string;
  /**
   * 會員電話（完整 8 位；黎自 `online-customer-cache`）。
   * 空 = 快取失效（硬 reload）→ topup 選項要人手輸入電話先駁到 Ledger。
   */
  memberPhone?: string;
  /** 原價合計（paymentBase.total，未扣折扣） */
  baseTotal: number;
  /** 全單折扣金額 */
  discountAmount: number;
  /** 線上已付金額（prepaidAmount） */
  prepaidAmount: number;
  currency: string;
  busy: boolean;
  onClose: () => void;
  /**
   * 確認執行。topup 由父層（pos-app）call `applyPosTopup` 先攞 txn id 先至結帳；
   * 父層透過 `busy` 反映進行中，完成／失敗自行關閉或留低。
   */
  onConfirm: (params: { option: CheckoutDiffOption; reason?: string; phone?: string }) => void | Promise<void>;
};

/** 顯示用遮罩：63936542 → 6393****（純顯示，唔落盤）。
 *  共用 `lib/pos/checkout-diff.ts` 嘅純函式 —— 收據註腳（escpos-template）同
 *  訂單審計欄（pos-app 寫入 `diffPhoneMask`）都用同一份，三處口徑一致。 */
function maskPhone(phone: string): string {
  return maskPhoneForReceipt(phone);
}

/**
 * 結帳差額處理模態（2026-10-19 到店優惠改價，mockup v3 畫面 ⑤）。
 *
 * 觸發條件（父層守）：線上已付 > 新金額 → 應收 0，但客人多付咗錢。
 * 加菜情况（新價 > 已付）自動補收，**唔彈**呢個模態（現有行為不變）。
 *
 * 三選項：
 *  ① 充值返回原支付戶口（推薦）—— `applyPosTopup` 入會員通餘額，
 *     **堆疊一次「確認充值」**最後確認（拍板 ②），txn id 寫入訂單＋小票；
 *  ② 現金退款 —— 櫃現金支出，交班現金賬核對；
 *  ③ 唔退差額 · 店方保留 —— 必填原因，報表以其他收入補平。
 */
export function PosCheckoutDiffModal({
  orderCode,
  customerName,
  memberPhone,
  baseTotal,
  discountAmount,
  prepaidAmount,
  currency,
  busy,
  onClose,
  onConfirm,
}: PosCheckoutDiffModalProps) {
  const t = useT();
  const [option, setOption] = useState<CheckoutDiffOption>("topup");
  const [reason, setReason] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [confirmTopupOpen, setConfirmTopupOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const newTotal = Math.max(0, baseTotal - discountAmount);
  const diff = Math.max(0, prepaidAmount - newTotal);
  const phone = memberPhone ?? phoneInput.trim();
  const masked = phone ? maskPhone(phone) : "****";
  const disabled = busy || pending;
  const canConfirm =
    !disabled &&
    (option !== "none" || Boolean(reason.trim())) &&
    (option !== "topup" || Boolean(phone));

  const money = (value: number) => formatMoney(value, currency);

  const runConfirm = async (params: { option: CheckoutDiffOption; reason?: string; phone?: string }) => {
    setPending(true);
    try {
      await onConfirm(params);
    } finally {
      setPending(false);
    }
  };

  const optionDescription: Record<CheckoutDiffOption, string> = {
    topup: t("將執行：充值 {amt} 返回會員 {phone} 嘅原支付戶口（會員通餘額，即時到賬）；撳確認後會再彈一次「確認充值」，憑證號返回後寫入訂單同小票。", {
      amt: money(diff),
      phone: masked,
    }),
    cash: t("將執行：收銀櫃支現金 {amt} 畀客人；櫃現金 −{amt}，交班現金賬要核對。", { amt: money(diff) }),
    none: t("將執行：唔退差額，{amt} 由店方保留；必須填原因（記入訂單備註），報表以其他收入補平。", {
      amt: money(diff),
    }),
  };

  return (
    <ResponsiveModal
      actions={
        <>
          <button
            className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
            onClick={onClose}
            type="button"
          >
            {t("取消")}
          </button>
          <button
            className="rounded-2xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!canConfirm}
            onClick={() => {
              if (option === "topup") {
                // 充值要堆疊一次最後確認（拍板 ②）—— 防止收銀誤撳，錢即時到賬唔可撤銷。
                setConfirmTopupOpen(true);
                return;
              }
              void runConfirm({ option, reason: reason.trim() || undefined });
            }}
            type="button"
          >
            {busy || pending ? t("處理中…") : t("確認結帳並處理差額")}
          </button>
        </>
      }
      description={`${orderCode}${customerName ? ` · ${customerName}` : ""}`}
      onClose={onClose}
      title={t("差額處理")}
      widthClassName="max-w-2xl"
      zIndexClassName="z-[60]"
    >
      <div className="grid gap-3">
        {/* 金額總覽：原價 → 折扣 → 新金額 vs 線上已付 → 應收 0 */}
        <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm">
          <div className="flex items-center justify-between py-1">
            <span className="text-slate-500">{t("原價合計")}</span>
            <span className="font-semibold text-slate-900">{money(baseTotal)}</span>
          </div>
          {discountAmount > 0 ? (
            <div className="flex items-center justify-between py-1">
              <span className="text-slate-500">{t("全單折扣")}</span>
              <span className="font-semibold text-amber-700">−{money(discountAmount)}</span>
            </div>
          ) : null}
          <div className="flex items-center justify-between py-1">
            <span className="font-semibold text-slate-900">{t("新金額")}</span>
            <span className="text-base font-bold text-slate-900">{money(newTotal)}</span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-slate-500">{t("線上已付")}</span>
            <span className="font-semibold text-slate-900">{money(prepaidAmount)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between border-t border-slate-100 pt-2">
            <span className="text-slate-500">{t("應收金額（無需再收款）")}</span>
            <span className="font-semibold text-slate-900">{money(0)}</span>
          </div>
        </div>

        {/* 三選項 */}
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <div className="text-sm font-semibold text-slate-900">
            {t("客人多付 {amt}，點處理？", { amt: money(diff) })}
          </div>
          <div className="mt-2 grid gap-2">
            <button
              className={`rounded-2xl border px-3 py-3 text-left text-sm ${
                option === "topup" ? "border-orange-500 bg-orange-50" : "border-slate-200 bg-slate-50 hover:border-orange-300"
              }`}
              disabled={disabled}
              onClick={() => setOption("topup")}
              type="button"
            >
              <div className="flex items-center gap-2 font-semibold text-slate-900">
                <span
                  className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
                    option === "topup" ? "border-orange-500 bg-orange-500" : "border-slate-300 bg-white"
                  }`}
                >
                  {option === "topup" ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
                </span>
                {t("充值返回原支付戶口")}
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                  {t("推薦")}
                </span>
              </div>
              <div className="mt-1 text-xs font-normal text-slate-500">
                {t("即時入會員通餘額 · {name} {phone} · 返回交易憑證並寫入訂單同小票", {
                  name: customerName ?? t("會員"),
                  phone: masked,
                })}
              </div>
            </button>

            <button
              className={`rounded-2xl border px-3 py-3 text-left text-sm ${
                option === "cash" ? "border-orange-500 bg-orange-50" : "border-slate-200 bg-slate-50 hover:border-orange-300"
              }`}
              disabled={disabled}
              onClick={() => setOption("cash")}
              type="button"
            >
              <div className="flex items-center gap-2 font-semibold text-slate-900">
                <span
                  className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
                    option === "cash" ? "border-orange-500 bg-orange-500" : "border-slate-300 bg-white"
                  }`}
                >
                  {option === "cash" ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
                </span>
                {t("現金退款")}
                <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                  {t("櫃現金 −{amt}", { amt: money(diff) })}
                </span>
              </div>
              <div className="mt-1 text-xs font-normal text-slate-500">
                {t("收銀櫃支現金 {amt} 畀客人；交班現金賬要核對", { amt: money(diff) })}
              </div>
            </button>

            <button
              className={`rounded-2xl border px-3 py-3 text-left text-sm ${
                option === "none" ? "border-orange-500 bg-orange-50" : "border-slate-200 bg-slate-50 hover:border-orange-300"
              }`}
              disabled={disabled}
              onClick={() => setOption("none")}
              type="button"
            >
              <div className="flex items-center gap-2 font-semibold text-slate-900">
                <span
                  className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
                    option === "none" ? "border-orange-500 bg-orange-500" : "border-slate-300 bg-white"
                  }`}
                >
                  {option === "none" ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
                </span>
                {t("唔退差額 · 店方保留")}
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                  {t("要填原因")}
                </span>
              </div>
              <div className="mt-1 text-xs font-normal text-slate-500">
                {t("必填原因（記入訂單備註）；報表以其他收入補平")}
              </div>
            </button>
          </div>

          {/* 動態預覽：將執行…… */}
          <div className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
            {optionDescription[option]}
          </div>
        </div>

        {/* topup 而快取冇電話（硬 reload 過）→ 人手輸入 */}
        {option === "topup" && !memberPhone ? (
          <div>
            <div className="text-xs font-semibold text-slate-500">{t("會員電話（8 位，充值返回要用）")}</div>
            <input
              autoCapitalize="off"
              autoCorrect="off"
              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-base font-semibold tracking-widest text-slate-900"
              inputMode="numeric"
              maxLength={8}
              onChange={(event) => setPhoneInput(event.target.value.replace(/\D/g, ""))}
              placeholder={t("例如：63936542")}
              spellCheck={false}
              value={phoneInput}
            />
          </div>
        ) : null}

        {/* 店方保留：必填原因 */}
        {option === "none" ? (
          <div>
            <div className="text-xs font-semibold text-slate-500">{t("保留原因（必填）")}</div>
            <input
              autoCapitalize="off"
              autoCorrect="off"
              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-base text-slate-900"
              onChange={(event) => setReason(event.target.value)}
              placeholder={t("例如：堂食優惠差額，店方承擔")}
              spellCheck={false}
              value={reason}
            />
          </div>
        ) : null}

        <p className="text-xs text-slate-500">
          {t("只有「新金額 < 線上已付」先彈呢個處理 —— 加菜情况（新價 > 已付）會自動收差額，現有行為不變。")}
        </p>
      </div>

      {/* 堆疊：「確認充值」最後一步（拍板 ②） */}
      {confirmTopupOpen ? (
        <ResponsiveModal
          actions={
            <>
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={() => setConfirmTopupOpen(false)}
                type="button"
              >
                {t("取消")}
              </button>
              <button
                className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={disabled}
                onClick={() => {
                  setConfirmTopupOpen(false);
                  void runConfirm({ option: "topup", phone });
                }}
                type="button"
              >
                {busy || pending ? t("處理中…") : t("確認充值")}
              </button>
            </>
          }
          description={t("最後一步確認 —— 防止收銀誤撳")}
          onClose={() => setConfirmTopupOpen(false)}
          title={t("確認充值")}
          widthClassName="max-w-md"
          zIndexClassName="z-[70]"
        >
          <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm">
            <div className="flex items-center justify-between py-1">
              <span className="text-slate-500">{t("充值金額")}</span>
              <span className="font-bold text-slate-900">{money(diff)}</span>
            </div>
            <div className="flex items-center justify-between py-1">
              <span className="text-slate-500">{t("返回戶口")}</span>
              <span className="font-semibold text-slate-900">
                {t("會員通餘額")} · {customerName ?? t("會員")} {masked}
              </span>
            </div>
            <div className="flex items-center justify-between py-1">
              <span className="text-slate-500">{t("到賬時間")}</span>
              <span className="font-semibold text-slate-900">{t("即時")}</span>
            </div>
            <div className="flex items-center justify-between py-1">
              <span className="text-slate-500">{t("交易憑證")}</span>
              <span className="font-semibold text-slate-900">{t("返回後寫入訂單同小票")}</span>
            </div>
            <div className="flex items-center justify-between py-1">
              <span className="text-slate-500">{t("性質")}</span>
              <span className="font-semibold text-slate-900">{t("店方補回差額（Ledger 禁 POS 沖正餘額，故用 topup）")}</span>
            </div>
          </div>
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
            {t("充值後即時到賬、唔可撤銷。唔啱請撳「取消」返去結帳畫面再改。")}
          </p>
        </ResponsiveModal>
      ) : null}
    </ResponsiveModal>
  );
}
