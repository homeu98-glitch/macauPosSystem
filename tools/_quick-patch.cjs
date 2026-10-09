#!/usr/bin/env node
/**
 * Task #10 —— quick-* 家族 + 相關子元件 i18n 補丁。
 *
 * 覆蓋 5 個檔：
 *   1. quick-mode-orders-bar.tsx     —— pill prop 還原（唔可以雙重翻譯）+ useT
 *   2. quick-local-orders-strip.tsx  —— 顯示位 t()；payload 位保持原文
 *   3. self-order-action-buttons.tsx —— 接受／拒絕 + aria-label
 *   4. order-discount-display.tsx    —— 原/優惠/單品折扣/全單折扣/合計優惠
 *   5. local-orders-panel.tsx        —— 兩個上回漏咗嘅位
 *
 * 每個 edit 都 assert 命中次數；CRLF 入出。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const WRITE = process.argv.includes("--write");

let totalFails = 0;

function patch(rel, edits) {
  const file = path.join(ROOT, rel);
  let src = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const results = [];
  for (const [find, replace, expect] of edits) {
    const n = src.split(find).length - 1;
    const ok = n === expect;
    if (!ok) totalFails++;
    results.push({ find: find.slice(0, 70).replace(/\n/g, "⏎"), n, expect, ok });
    if (ok) src = src.split(find).join(replace);
  }
  if (WRITE && totalFails === 0) fs.writeFileSync(file, src.replace(/\n/g, "\r\n"));
  console.log(`\n### ${rel}  (${WRITE ? "WRITE" : "dry"})`);
  for (const r of results) {
    console.log(`  ${r.ok ? "✅" : "❌"} ${r.n}/${r.expect}  ${r.find}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 1. quick-mode-orders-bar.tsx
// ─────────────────────────────────────────────────────────────
patch("src/components/quick-mode-orders-bar.tsx", [
  [
    `import { AutoAcceptPill } from "@/components/auto-accept-pill";\n`,
    `import { AutoAcceptPill } from "@/components/auto-accept-pill";\nimport { useT } from "@/components/lang-provider";\n`,
    1,
  ],
  // 🔴 AutoAcceptPill 內部會 `t(label)` / `t(busyHint)` ⇒ call site 一定要傳原文。
  [
    `  if (!storeId) return null; // 冇登入記錄 → 唔顯示，避免商家以為設定咗\n\n  return (\n    <AutoAcceptPill`,
    `  if (!storeId) return null; // 冇登入記錄 → 唔顯示，避免商家以為設定咗\n\n  // ⚠️ AutoAcceptPill 內部會 t(label) / t(busyHint)：以下 prop 一定要傳原文\n  //    （＝字典 key），唔可以自己先包一層 t()（會變雙重翻譯）。\n  return (\n    <AutoAcceptPill`,
    1,
  ],
  [`\n      label={t("自動接單")}`, `\n      label="自動接單"`, 1],
  [`\n        label={t("自動接單")}`, `\n        label="自動接單"`, 1],
  [
    `}: QuickModeOrdersBarProps) {\n  return (`,
    `}: QuickModeOrdersBarProps) {\n  const t = useT();\n\n  return (`,
    1,
  ],
]);

// ─────────────────────────────────────────────────────────────
// 2. quick-local-orders-strip.tsx
// ─────────────────────────────────────────────────────────────
patch("src/components/quick-local-orders-strip.tsx", [
  [
    `import { OrderSourceBadge } from "@/components/order-source-badge";\n`,
    `import { useT } from "@/components/lang-provider";\nimport { OrderSourceBadge } from "@/components/order-source-badge";\n`,
    1,
  ],
  [`}) {\n  const completeText = completeLabel(order);`, `}) {\n  const t = useT();\n  const completeText = completeLabel(order);`, 1],
  [
    `}: QuickLocalOrdersStripProps) {\n  // 單一列`,
    `}: QuickLocalOrdersStripProps) {\n  const t = useT();\n\n  // 單一列`,
    1,
  ],
  // 付款藥丸（第 1 層顯示文案；local-orders-panel 同一做法）
  [`              {paymentBadge.label}\n`, `              {t(paymentBadge.label)}\n`, 1],
  // 狀態藥丸：completionLabel 係純顯示文案（quickCompletionLabel）
  [
    `            {isDraftSelfOrder ? "點單中" : mode === "waiting" ? completionLabel(order) : "製作中"}\n`,
    `            {isDraftSelfOrder ? t("點單中") : mode === "waiting" ? t(completionLabel(order)) : t("製作中")}\n`,
    1,
  ],
  // 平台實收細字行：合併成一個 key（唔好拆做 fragment）
  [
    `                  {t("實收 ")}{formatMoney(payout, currency)}\n`,
    `                  {t("實收 {amt}", { amt: formatMoney(payout, currency) })}\n`,
    1,
  ],
  // 4 個 aria-label 樣板字串
  [
    "            aria-label={`取消（覆寫）平台單 ${order.localOrderNo}`}\n",
    `            aria-label={t("取消（覆寫）平台單 {no}", { no: order.localOrderNo })}\n`,
    1,
  ],
  [
    "                aria-label={`去結帳 ${order.localOrderNo}`}\n",
    `                aria-label={t("去結帳 {no}", { no: order.localOrderNo })}\n`,
    1,
  ],
  [
    "                aria-label={`標記可取餐 ${order.localOrderNo}`}\n",
    `                aria-label={t("標記可取餐 {no}", { no: order.localOrderNo })}\n`,
    1,
  ],
  [
    "                aria-label={`完成取餐 ${order.localOrderNo}`}\n",
    `                aria-label={t("完成取餐 {no}", { no: order.localOrderNo })}\n`,
    1,
  ],
  // 🔴 只改顯示位；`onMarkCompleted(order.id, completeText)` 係持久化 payload，保持原文
  [`                {completeText}\n`, `                {t(completeText)}\n`, 2],
]);

// ─────────────────────────────────────────────────────────────
// 3. self-order-action-buttons.tsx
// ─────────────────────────────────────────────────────────────
patch("src/components/self-order-action-buttons.tsx", [
  [
    `import { useState } from "react";\n`,
    `import { useState } from "react";\n\nimport { useT } from "@/components/lang-provider";\n`,
    1,
  ],
  [
    `  const [pending, setPending] = useState<Action | null>(null);\n`,
    `  const [pending, setPending] = useState<Action | null>(null);\n  const t = useT();\n`,
    1,
  ],
  [
    "        aria-label={`接受自助單 ${orderLabel}`}\n",
    `        aria-label={t("接受自助單 {no}", { no: orderLabel })}\n`,
    1,
  ],
  [
    "        aria-label={`拒絕自助單 ${orderLabel}`}\n",
    `        aria-label={t("拒絕自助單 {no}", { no: orderLabel })}\n`,
    1,
  ],
  [`      >\n        接受\n      </button>`, `      >\n        {t("接受")}\n      </button>`, 1],
  [`      >\n        拒絕\n      </button>`, `      >\n        {t("拒絕")}\n      </button>`, 1],
]);

// ─────────────────────────────────────────────────────────────
// 4. order-discount-display.tsx
// ─────────────────────────────────────────────────────────────
patch("src/components/order-discount-display.tsx", [
  [
    `import type { OrderItem } from "@/lib/types";\n`,
    `"use client";\n\nimport type { OrderItem } from "@/lib/types";\n`,
    1,
  ],
  [
    `import { discountedUnitPrice, itemDiscountSaving, orderItemDiscountTotal } from "@/lib/pos/discount";\n`,
    `import { discountedUnitPrice, itemDiscountSaving, orderItemDiscountTotal } from "@/lib/pos/discount";\nimport { useT } from "@/components/lang-provider";\n`,
    1,
  ],
  [
    `export function OrderItemDiscountLine({ item, currency, variant = "compact" }: OrderItemDiscountLineProps) {\n`,
    `export function OrderItemDiscountLine({ item, currency, variant = "compact" }: OrderItemDiscountLineProps) {\n  // ⚠️ useT() 一定要喺所有 early return 之前（Rules of Hooks）。\n  const t = useT();\n`,
    1,
  ],
  [
    `        原 {formatMoney(item.price * item.quantity, currency)}\n`,
    `        {t("原 {amt}", { amt: formatMoney(item.price * item.quantity, currency) })}\n`,
    1,
  ],
  [
    `      <span className="text-[11px] font-semibold text-emerald-700">優惠 {formatMoney(saving, currency)}</span>\n`,
    `      <span className="text-[11px] font-semibold text-emerald-700">\n        {t("優惠 {amt}", { amt: formatMoney(saving, currency) })}\n      </span>\n`,
    1,
  ],
  [
    `export function OrderDiscountRow({ items, currency, wholeOrderDiscountAmount, variant = "block" }: OrderDiscountRowProps) {\n`,
    `export function OrderDiscountRow({ items, currency, wholeOrderDiscountAmount, variant = "block" }: OrderDiscountRowProps) {\n  // ⚠️ useT() 一定要喺 early return（total <= 0）之前（Rules of Hooks）。\n  const t = useT();\n`,
    1,
  ],
  [`<span className="text-slate-500">單品折扣</span>`, `<span className="text-slate-500">{t("單品折扣")}</span>`, 1],
  [`<span className="text-slate-500">全單折扣</span>`, `<span className="text-slate-500">{t("全單折扣")}</span>`, 1],
  [`<span className="font-semibold text-slate-700">合計優惠</span>`, `<span className="font-semibold text-slate-700">{t("合計優惠")}</span>`, 1],
]);

// ─────────────────────────────────────────────────────────────
// 5. local-orders-panel.tsx —— 上回漏咗嘅兩個位
// ─────────────────────────────────────────────────────────────
patch("src/components/local-orders-panel.tsx", [
  // ⚠️ 呢個 toast 係「已填值字串」（字典 key 係 `{no} {status}。`）⇒ 永遠命中唔到字典。
  [
    "        onChanged(`${order.localOrderNo} ${completeText}。`, { closeModal: true });\n",
    `        onChanged(t("{no} {status}。", { no: order.localOrderNo, status: t(completeText) }), { closeModal: true });\n`,
    1,
  ],
  [`      {completeText}\n`, `      {t(completeText)}\n`, 1],
]);

console.log(WRITE ? (totalFails ? `\n❌ ${totalFails} 個 edit 冇命中` : "\n✅ 全部命中，已落盤") : "\n（dry-run）");
process.exit(totalFails ? 1 : 0);
