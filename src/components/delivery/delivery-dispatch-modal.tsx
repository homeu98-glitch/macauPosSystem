"use client";

import { useEffect, useMemo, useState } from "react";

import { useT } from "@/components/lang-provider";
import { loadAuthSession, loadBootstrapCache } from "@/lib/storage";
import { ResponsiveModal } from "@/components/responsive-modal";
import { isDeliveryLiveEnabled } from "@/lib/pos/delivery/flag";
import {
  composeDeliveryAddress,
  isAddressReady,
  MACAU_DELIVERY_ZONES,
  matchZoneFromAddress,
  OTHER_ZONE,
} from "@/lib/pos/delivery/zones";
import type { PosDeliveryJob } from "@/lib/pos/delivery/types";
import type { DeliveryDispatchTarget } from "@/lib/pos/delivery/use-delivery-dispatch";

/**
 * 「外送派單」彈窗 —— 三個入口共用（訂單頁卡片／快餐 strip／外送 tab）。
 *
 * ## 為什麼要有呢個彈窗（唔係直接派）
 *
 * 車手平台要嘅資料，POS 本身**冇**（店內單冇客人地址、平台單冇地址）。
 * 冇地址／電話就派出去 = 車手去到唔知邊度、或者要打返店問，商家寧願唔派。
 * 所以一律要經過呢個彈窗補齊。
 *
 * ## 必填只有 2 項
 *
 * | 欄位 | 必填 | 理由 |
 * |---|---|---|
 * | 聯絡電話 | ✅ | 車手唯一可以即時聯絡客人嘅方法 |
 * | 送貨地址 | ✅ | 冇地址唔知送去邊 |
 * | 座標 | ❌ | 本 repo 冇地圖 SDK（見 `package.json`），硬性要求 = 商家派唔到；有就填，Ledger 缺座標會另行提示 |
 * | 車手費 | 預設 30 | 有默認值，唔算「未填」 |
 * | 代收貨款 | 預設 0（唔收） | 平台單多數已付款 |
 *
 * ## 未接通車手平台時
 *
 * `NEXT_PUBLIC_DELIVERY_LIVE` 未開（默認）→ 底部明寫「只儲存派單資料，唔會真的叫車」。
 * 呢句**唔可以省** —— 商家以為叫咗車、結果冇人上門，比冇呢個掣更差。
 */

type DeliveryDispatchModalProps = {
  storeId: string | null;
  target: DeliveryDispatchTarget | null;
  /** 建單人（顯示用 + 審計） */
  createdBy?: string | null;
  onClose: () => void;
  onSaved: (job: PosDeliveryJob) => void;
};

type SubmitState = { status: "idle" } | { status: "saving" } | { status: "error"; message: string };

/** 車手費預設值（MOP）—— 同 Ledger `siteb-dispatch-fee-options` 嘅預設一致。 */
const DEFAULT_FEE_MOP = 30;

/**
 * 車手費快速選項（2026-10-31 商家指定）。
 * 全部都喺 Ledger `SITE_B_DISPATCH_FEE_OPTIONS_MOP`（20–150，每 5 一個）之內，
 * 所以將來接 B1 一定過得到驗證。想自訂就打下面個輸入框。
 */
const FEE_PRESETS_MOP = [30, 35, 40, 50, 60] as const;

/**
 * 送貨備註快速選項（2026-10-31）。
 *
 * 揀自網上「速遞／外送備註」常見建議（唔好按門鈴、放管理處、到達前致電…），
 * 呢五句覆蓋大部分情況。⚠️ 只係「撳一下填入」，商家仍然可以自由改。
 */
const NOTE_PRESETS = [
  "到達前請致電",
  "不要按門鈴",
  "放喺管理處",
  "放喺門口即可，唔使拍門",
  "有小朋友／寵物，請輕聲",
] as const;

/** 錯誤碼 → 字典 key（全部都要喺中英字典出現）。 */
const ERROR_KEYS: Record<string, string> = {
  bad_source: "訂單來源唔正確",
  bad_ref: "訂單編號唔正確",
  bad_mode: "配送方式唔正確",
  platform_delivery: "平台專送單唔可以由 POS 派送",
  missing_phone: "請填寫聯絡電話",
  bad_phone: "電話格式唔正確",
  missing_address: "請填寫送貨地址",
  bad_coords: "座標唔正確",
  bad_fee: "車手費超出可接受範圍",
  bad_cod: "代收金額超出可接受範圍",
  dispatch_exists: "呢張單已經有進行中嘅派單",
  table_not_ready: "派單資料表未建立，請先執行資料庫更新",
  server_not_configured: "伺服器未配置，暫時存唔到派單",
  bad_json: "資料格式唔正確",
  missing_store: "缺少店鋪資料，請重新登入",
};

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

export function DeliveryDispatchModal({
  storeId,
  target,
  createdBy,
  onClose,
  onSaved,
}: DeliveryDispatchModalProps) {
  const t = useT();
  const live = isDeliveryLiveEnabled();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  /** 送貨區份（`MACAU_DELIVERY_ZONES` 之一，或「其他」）。 */
  const [zone, setZone] = useState("");
  /** 詳細地址（可以留空 —— 商家之後補，車手靠電話問）。 */
  const [addressDetail, setAddressDetail] = useState("");
  const [note, setNote] = useState("");
  const [fee, setFee] = useState(String(DEFAULT_FEE_MOP));
  const [feePaidBy, setFeePaidBy] = useState<"shop" | "customer">("shop");
  const [codEnabled, setCodEnabled] = useState(false);
  const [cod, setCod] = useState("");
  /**
   * ⚠️ 刻意冇座標 state（2026-10-31）：商家只有地址，冇可能填經緯度。
   * `pos_delivery_jobs.customer_lat/lng` 保留 NULL，唔會假造。
   */
  const [submit, setSubmit] = useState<SubmitState>({ status: "idle" });
  /** 平台單預填狀態（`idle` = 唔關平台事；`loading` 顯示「帶入中」）。 */
  const [prefill, setPrefill] = useState<"idle" | "loading" | "done" | "error">("idle");
  /** 平台只提供遮罩電話時嘅原文（例如 `853-****9190`），用嚟解釋為何要自己填。 */
  const [maskedPhone, setMaskedPhone] = useState<string | null>(null);

  // 換單（或者重開）時重置所有欄位 —— 唔可以殘留上一張單嘅地址／電話。
  useEffect(() => {
    if (!target) return;
    setName(target.defaultCustomerName ?? "");
    setPhone(target.defaultCustomerPhone ?? "");
    // 有預設地址（線上單帶入）就順手拆區份，等商家只需要確認
    {
      const preset = target.defaultCustomerAddress ?? "";
      const matched = matchZoneFromAddress(preset);
      setZone(matched ?? "");
      setAddressDetail(matched ? preset.slice(matched.length).trim() : preset);
    }
    setNote("");
    setFee(String(DEFAULT_FEE_MOP));
    setFeePaidBy("shop");
    setCodEnabled(false);
    setCod("");
    setSubmit({ status: "idle" });
    setPrefill("idle");
    setMaskedPhone(null);
  }, [target]);

  /**
   * 平台單預填（2026-10-31）。
   *
   * 平台 raw payload 本身有姓名／地址／電話（見 `platform-customer.ts`），
   * 但 `pos_orders` 冇客人欄位 —— 所以打開彈窗時**逐張**向 server 要一次。
   *
   * ⚠️ 逐張拉而唔係一次過拉一批：呢度回嘅係個資，唔應該傾倒去前端。
   * ⚠️ 只用 `prev || value` 填空：用戶喺 fetch 返嚟之前已經打咗字，就唔可以蓋走。
   */
  useEffect(() => {
    if (!target?.platform || !storeId) return;
    let cancelled = false;
    setPrefill("loading");
    void (async () => {
      try {
        const params = new URLSearchParams({ storeId, orderId: target.orderRef });
        const res = await fetch(`/api/pos/delivery/prefill?${params.toString()}`, {
          cache: "no-store",
        });
        const json = (await res.json()) as {
          ok?: boolean;
          prefill?: { name?: string; phone?: string; address?: string; remark?: string; phoneMasked?: string };
        };
        if (cancelled) return;
        if (!json?.ok) {
          setPrefill("error");
          return;
        }
        const data = json.prefill ?? {};
        if (data.name) setName((prev) => prev || (data.name as string));
        if (data.phone) setPhone((prev) => prev || (data.phone as string));
        if (data.address) {
          const raw = data.address as string;
          const matched = matchZoneFromAddress(raw);
          if (matched) {
            setZone(matched);
            setAddressDetail((prev) => prev || raw.slice(matched.length).trim());
          } else {
            setAddressDetail((prev) => prev || raw);
          }
        }
        if (data.remark) setNote((prev) => prev || (data.remark as string));
        setMaskedPhone(data.phoneMasked ?? null);
        setPrefill("done");
      } catch {
        if (!cancelled) setPrefill("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, storeId]);

  const filled = useMemo(() => {
    return {
      phone: phone.trim().length > 0,
      // 只有區份都夠（詳細地址可以後補）—— 見 `zones.ts` `isAddressReady()`
      address: isAddressReady(zone, addressDetail),
    };
  }, [phone, zone, addressDetail]);
  const ready = filled.phone && filled.address;
  /**
   * 「已寫在單上」要填嘅號碼（2026-10-31 商家指定：**登入電話**，唔係收據電話）。
   *
   * 優先次序：
   *   ① `AuthSession.account` —— 商家登入用嘅電話（畫面上方顯示嗰個，例如 60000002）
   *   ② `AuthSession.topUpShopId` —— 註釋寫明「通常為店主電話」
   *   ③ `PosBootstrap.storeTel` —— 收據抬頭電話（最後防線）
   * 只有「睇落係電話」（6–15 位數字、冇 `*`）才採用，否則當冇 → 按鈕 disable。
   */
  const [contactPhoneFallback] = useState(() => {
    const session = loadAuthSession();
    const candidates = [session?.account, session?.topUpShopId, loadBootstrapCache()?.storeTel];
    for (const candidate of candidates) {
      const value = String(candidate ?? "").trim();
      if (!value || value.includes("*")) continue;
      const digits = value.replace(/\D/g, "");
      if (digits.length >= 6 && digits.length <= 15) return value;
    }
    return "";
  });

  if (!target) return null;

  const platformLabel = target.platform === "aomi" ? "澳覓" : target.platform === "mfood" ? "MFOOD" : null;

  async function handleSubmit() {
    if (!target || !storeId) return;
    if (!ready) {
      setSubmit({ status: "error", message: t("請先填寫聯絡電話同送貨地址") });
      return;
    }
    const feeNum = toNumber(fee);
    const codNum = codEnabled ? toNumber(cod) : 0;
    if (feeNum === null) {
      setSubmit({ status: "error", message: t("車手費超出可接受範圍") });
      return;
    }
    if (codNum === null) {
      setSubmit({ status: "error", message: t("代收金額超出可接受範圍") });
      return;
    }

    setSubmit({ status: "saving" });
    try {
      const res = await fetch("/api/pos/delivery/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId,
          orderSource: target.orderSource,
          orderRef: target.orderRef,
          orderNoSnapshot: target.orderNoSnapshot,
          platform: target.platform ?? null,
          deliveryMode: target.deliveryMode,
          customer: {
            name: name.trim(),
            phone: phone.trim(),
            address: composeDeliveryAddress(zone, addressDetail),
            note: note.trim(),
            // 冇座標：商家只知地址（見上面註解）。`job-input` 會存 NULL。
          },
          feeAmountMop: feeNum,
          feePaidBy,
          codAmountMop: codNum,
          createdBy: createdBy ?? null,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        job?: PosDeliveryJob;
        error?: string;
      };
      if (!res.ok || !json.ok || !json.job) {
        const key = ERROR_KEYS[String(json.error ?? "")] ?? "";
        setSubmit({
          status: "error",
          message: key ? t(key) : t("儲存派單失敗，請檢查網絡後重試"),
        });
        return;
      }
      onSaved(json.job);
      onClose();
    } catch {
      setSubmit({ status: "error", message: t("儲存派單失敗，請檢查網絡後重試") });
    }
  }

  /**
   * 備註快速選項：撳一下加入（可以連撳幾個），已經有就唔重複。
   * ⚠️ 用 `；` 分隔而唔係覆蓋 —— 商家通常會同時要「到達前請致電」+「不要按門鈴」。
   */
  function appendNote(value: string) {
    setNote((prev) => {
      const current = prev.trim();
      if (!current) return value;
      if (current.includes(value)) return current;
      return `${current}；${value}`;
    });
  }

  const inputClass =
    "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100";

  return (
    <ResponsiveModal
      onClose={onClose}
      // 手機彈鍵盤時跟視覺視窗縮放，唔好把整個彈窗推上去
      trackVisualViewport
      widthClassName="max-w-3xl"
      header={
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-bold text-slate-900">{t("外送派單")}</h3>
              <span className="rounded-lg bg-orange-50 px-2 py-0.5 text-[11px] font-semibold text-orange-700">
                {target.orderNoSnapshot || t("未命名訂單")}
              </span>
              {platformLabel ? (
                <span className="rounded-lg bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                  {platformLabel}
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>
                {target.totalMop !== undefined
                  ? t("客付合計 MOP {total} · 單號維持不變", { total: target.totalMop.toFixed(2) })
                  : t("單號維持不變")}
              </span>
              {prefill === "loading" ? <span className="text-slate-400">{t("平台資料帶入中…")}</span> : null}
              {prefill === "done" ? (
                <span className="font-semibold text-emerald-600">{t("已由平台單帶入，可以修改")}</span>
              ) : null}
            </div>
          </div>
        </div>
      }
      actions={
        <div className="flex w-full items-center gap-2">
          <div className="min-w-0 flex-1 text-xs text-slate-500">
            {submit.status === "error" ? (
              <span className="font-semibold text-rose-600">{submit.message}</span>
            ) : ready ? (
              t("車手費 MOP {fee} · {payer}", {
                fee: toNumber(fee)?.toFixed(2) ?? "0.00",
                payer: feePaidBy === "customer" ? t("客人支付") : t("商戶支付"),
              })
            ) : (
              <span className="font-semibold text-amber-600">{t("請先填寫聯絡電話同送貨地址")}</span>
            )}
          </div>
          <button
            className="whitespace-nowrap rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700"
            onClick={onClose}
            type="button"
          >
            {t("取消")}
          </button>
          <button
            className="whitespace-nowrap rounded-xl bg-orange-600 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
            disabled={submit.status === "saving" || !ready || !storeId}
            onClick={() => void handleSubmit()}
            type="button"
          >
            {submit.status === "saving" ? t("儲存中…") : t("確認派單")}
          </button>
        </div>
      }
    >
      {/* ⚠️ 唔可以再加 `px-4 py-4` —— `ResponsiveModal` 嘅 body 已經有
          `px-4 py-4 sm:px-5`，加埋會變雙重內距（彈窗窄位時會提早換行）。 */}
      {/*
        排版（2026-10-31 商家確認稿）：**橫向 4 行**，唔再左右各一格。
        原本左欄長、右欄短，右邊大片留白；而家每行放兩三組短欄位，高度少約 40%。
        斷點全部用 `md:` —— 手機維持單欄，唔會擠。
      */}

      {/* ── 第 1 行：收件人 ／ 聯絡電話 ／ 車手費 ── */}
      <div className="grid gap-4 md:grid-cols-[1fr_1.15fr_1.4fr]">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">
            {t("收件人")} <span className="font-normal text-slate-400">（{t("選填")}）</span>
          </span>
          <input
            className={inputClass}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("例如：陳小姐")}
            value={name}
          />
        </label>

        <div className="block">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-600">
              {t("聯絡電話")} <span className="text-rose-500">＊</span>
            </span>
            {/* 「已寫在單上」＝用**登入電話**（畫面頂顯示嗰個），車手打返舖頭就得。 */}
            <button
              className="rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700 disabled:opacity-40"
              disabled={!contactPhoneFallback}
              onClick={() => setPhone(contactPhoneFallback)}
              title={
                contactPhoneFallback
                  ? t("填入登入電話：{tel}", { tel: contactPhoneFallback })
                  : t("未設定登入電話，請自行輸入")
              }
              type="button"
            >
              {t("已寫在單上")}
            </button>
          </div>
          <input
            className={inputClass}
            inputMode="tel"
            onChange={(event) => setPhone(event.target.value)}
            placeholder="6612 3456"
            value={phone}
          />
          {/* 澳覓只提供遮罩電話（853-****9190）—— 講清楚，唔好令店員以為有得用 */}
          {maskedPhone ? (
            <span className="mt-1 block text-[11px] text-amber-700">
              {t("平台只提供遮罩電話（{phone}），請自行輸入可聯絡號碼。", { phone: maskedPhone })}
            </span>
          ) : null}
        </div>

        <div className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">{t("車手費（MOP）")}</span>
          <div className="flex items-center gap-2">
            {/* 常用金額一撳即填；想特別金額就直接改右邊個輸入框 */}
            <div className="flex flex-wrap gap-1.5">
              {FEE_PRESETS_MOP.map((amount) => {
                const active = toNumber(fee) === amount;
                return (
                  <button
                    key={amount}
                    className={`min-w-[44px] rounded-xl px-2 py-2 text-xs font-bold tabular-nums ${
                      active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"
                    }`}
                    onClick={() => setFee(String(amount))}
                    type="button"
                  >
                    {amount}
                  </button>
                );
              })}
            </div>
            <input
              className={`${inputClass} w-20 shrink-0 text-center font-bold tabular-nums`}
              inputMode="decimal"
              onChange={(event) => setFee(event.target.value)}
              value={fee}
            />
          </div>
        </div>
      </div>

      {/* ── 第 2 行：地區（固定 170px）＋ 詳細地址 ── */}
      <div className="mt-3 grid gap-4 md:grid-cols-[170px_1fr]">
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-600">
            {t("地區")} <span className="text-rose-500">＊</span>
          </label>
          {/* 先揀區份（商家一定知），詳細地址可以後補 —— 打完整地址喺平板好痛苦 */}
          <select
            aria-label={t("地區")}
            className={`${inputClass} ${zone ? "" : "text-slate-400"}`}
            onChange={(event) => setZone(event.target.value)}
            value={zone}
          >
            <option value="">{t("請選擇地區")}</option>
            {MACAU_DELIVERY_ZONES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
            <option value={OTHER_ZONE}>{t("其他（下面自己打）")}</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-600">
            {t("詳細地址")} <span className="font-normal text-slate-400">（{t("選填")}）</span>
          </label>
          <input
            className={inputClass}
            onChange={(event) => setAddressDetail(event.target.value)}
            placeholder={
              zone === OTHER_ZONE
                ? t("請輸入地址（例如：橫琴口岸 3 號門）")
                : t("例如 88 號 5 樓 A（可後補）")
            }
            value={addressDetail}
          />
          {/* 揀「其他」但未打地址 → 明確講唔夠，唔好等撳咗確認才彈錯 */}
          {zone === OTHER_ZONE && !addressDetail.trim() ? (
            <span className="mt-1 block text-[11px] font-semibold text-rose-600">
              {t("揀「其他」要自己填地址。")}
            </span>
          ) : null}
        </div>
      </div>
      <div className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
        {t("車手靠上面嘅地址送貨，請寫清楚樓層、單位、入口；到達時車手可以一鍵致電客人。")}
      </div>

      {/* ── 第 3 行：邊個付 ／ 代收 ／ 代收金額 ── */}
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        <div>
          <span className="mb-1 block text-xs font-semibold text-slate-600">{t("邊個付車手費")}</span>
          <div className="grid grid-cols-2 gap-2">
            <button
              className={`rounded-xl px-3 py-2.5 text-sm font-semibold ${
                feePaidBy === "shop" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
              }`}
              onClick={() => setFeePaidBy("shop")}
              type="button"
            >
              {t("商戶支付")}
            </button>
            <button
              className={`rounded-xl px-3 py-2.5 text-sm font-semibold ${
                feePaidBy === "customer" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
              }`}
              onClick={() => setFeePaidBy("customer")}
              type="button"
            >
              {t("客人支付")}
            </button>
          </div>
        </div>

        <div>
          <span className="mb-1 block text-xs font-semibold text-slate-600">{t("代收貨款")}</span>
          <div className="grid grid-cols-2 gap-2">
            <button
              className={`rounded-xl px-3 py-2.5 text-sm font-semibold ${
                codEnabled ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
              }`}
              onClick={() => setCodEnabled(true)}
              type="button"
            >
              {t("需要代收")}
            </button>
            <button
              className={`rounded-xl px-3 py-2.5 text-sm font-semibold ${
                !codEnabled ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
              }`}
              onClick={() => setCodEnabled(false)}
              type="button"
            >
              {t("唔需要")}
            </button>
          </div>
        </div>

        <div>
          <span className="mb-1 block text-xs font-semibold text-slate-600">{t("代收金額（MOP）")}</span>
          <input
            className={`${inputClass} disabled:bg-slate-50 disabled:text-slate-400`}
            disabled={!codEnabled}
            inputMode="decimal"
            onChange={(event) => setCod(event.target.value)}
            placeholder={codEnabled ? t("例如 128") : t("需要代收時才填")}
            value={cod}
          />
        </div>
      </div>

      {/* ── 第 4 行：備註 chips 一行過 ＋ 全寬 textarea ── */}
      <div className="mt-3">
        <span className="mb-1 block text-xs font-semibold text-slate-600">{t("送貨備註")}</span>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {NOTE_PRESETS.map((preset) => (
            <button
              key={preset}
              className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700"
              onClick={() => appendNote(preset)}
              type="button"
            >
              {t(preset)}
            </button>
          ))}
        </div>
        <textarea
          className={`${inputClass} min-h-[56px] resize-none`}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t("例如：管理處交收、到達請致電")}
          value={note}
        />
      </div>

      {/* 底部提醒：個資範圍 ＋（未接通時）明寫唔會真的叫車 */}
      <div className="mt-3 space-y-2">
        <div className="rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
          {t("車手只會見到送貨所需資料（電話、地址、備註），唔會見到訂單金額。")}
        </div>
        {!live ? (
          <div className="rounded-xl bg-amber-50 px-3 py-2.5 text-[11px] font-semibold leading-relaxed text-amber-800">
            {t("車手平台未接通：現時只會儲存派單資料，唔會真的叫車。")}
          </div>
        ) : null}
      </div>
    </ResponsiveModal>
  );
}
