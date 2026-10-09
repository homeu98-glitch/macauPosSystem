#!/usr/bin/env node
/** P3 —— soldout-page.tsx + members-page.tsx i18n 補丁（codemod 之後嘅人手部分）。 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const WRITE = process.argv.includes("--write");
let fails = 0;

function patch(rel, edits) {
  let src = fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
  console.log(`\n### ${rel}`);
  for (const [find, replace, expect] of edits) {
    const n = src.split(find).length - 1;
    const ok = n === expect;
    if (!ok) fails++;
    console.log(`  ${ok ? "✅" : "❌"} ${n}/${expect}  ${find.slice(0, 76).replace(/\n/g, "⏎")}`);
    if (ok) src = src.split(find).join(replace);
  }
  if (WRITE) fs.writeFileSync(path.join(ROOT, rel), src.replace(/\n/g, "\r\n"));
}

// ───────────────── soldout-page.tsx ─────────────────
patch("src/components/soldout-page.tsx", [
  [
    `import { FixedNumberPad } from "@/components/fixed-number-pad";\n`,
    `import { FixedNumberPad } from "@/components/fixed-number-pad";\nimport { useT } from "@/components/lang-provider";\n`,
    1,
  ],
  [
    `export function SoldOutPage() {\n`,
    `export function SoldOutPage() {\n  // ⚠️ 一定要放喺所有 early return 之前（Rules of Hooks）。\n  const t = useT();\n`,
    1,
  ],
  // `status` 係「字典 key」，顯示位先 t()
  [`            {status}\n`, `            {t(status)}\n`, 1],
  // 被 expression 斬碎 → 合併成單一 key
  [
    `                    {t("共 ")}{filteredMenuItems.length} {t("個菜品 · 第 ")}{page}/{totalPages} {t("頁（每頁 ")}{pageSize}）\n`,
    `                    {t("共 {count} 個菜品 · 第 {page}/{total} 頁（每頁 {size}）", {\n                      count: filteredMenuItems.length,\n                      page,\n                      total: totalPages,\n                      size: pageSize,\n                    })}\n`,
    1,
  ],
  // FixedNumberPad：title/subtitle 係 raw render（要自己譯）；confirmLabel 內部會 t()（傳原文）
  [
    `            subtitle={selectedItem ? \`正在設定：\${selectedItem.name}\` : "先在左邊選一個菜品"}\n`,
    `            subtitle={\n              selectedItem\n                ? t("正在設定：{name}", { name: selectedItem.name })\n                : t("先在左邊選一個菜品")\n            }\n`,
    1,
  ],
]);

// ───────────────── members-page.tsx ─────────────────
patch("src/components/members-page.tsx", [
  [
    `import { FixedNumberPad } from "@/components/fixed-number-pad";\n`,
    `import { FixedNumberPad } from "@/components/fixed-number-pad";\nimport { useT } from "@/components/lang-provider";\n`,
    1,
  ],
  // GrantList：emptyLabel 係 raw render ⇒ 由元件自己譯
  [
    `  grants: LedgerMemberGrantRecord[];\n}) {\n  if (grants.length === 0) {\n    return <div className="text-sm text-slate-500">{emptyLabel}</div>;\n  }\n`,
    `  grants: LedgerMemberGrantRecord[];\n}) {\n  const t = useT();\n  if (grants.length === 0) {\n    return <div className="text-sm text-slate-500">{t(emptyLabel)}</div>;\n  }\n`,
    1,
  ],
  [`              {grantTypeLabel(grant.prizeType)}\n`, `              {t(grantTypeLabel(grant.prizeType))}\n`, 1],
  [`            {grantStatusLabel(grant.status)}\n`, `            {t(grantStatusLabel(grant.status))}\n`, 1],
  // 到期 + 日期
  [`              {t("到期 ")}{formatGrantExpiry(grant.expiresAt)}\n`, `              {t("到期 {date}", { date: formatGrantExpiry(grant.expiresAt) })}\n`, 1],
  // MembersPage 本體
  [
    `export function MembersPage() {\n  const router = useRouter();\n`,
    `export function MembersPage() {\n  // ⚠️ 一定要放喺所有 early return 之前（Rules of Hooks）。\n  const t = useT();\n  const router = useRouter();\n`,
    1,
  ],
  [`          {topupBusy ? "處理中…" : topupLabel}\n`, `          {topupBusy ? t("處理中…") : t(topupLabel)}\n`, 1],
  [`          {topupMsg.text}\n`, `          {t(topupMsg.text)}\n`, 1],
  [`                    {listBusy ? "搜尋中…" : "搜尋"}\n`, `                    {listBusy ? t("搜尋中…") : t("搜尋")}\n`, 1],
  [`                {searchHint ? <div className="mt-2 text-xs text-red-600">{searchHint}</div> : null}\n`, `                {searchHint ? <div className="mt-2 text-xs text-red-600">{t(searchHint)}</div> : null}\n`, 1],
  [`                    {listMsg.text}\n`, `                    {t(listMsg.text)}\n`, 1],
  [`                      {listBusy ? "載入中…" : "載入更多"}\n`, `                      {listBusy ? t("載入中…") : t("載入更多")}\n`, 1],
  [`                            {item.displayName ?? item.nickName ?? "會員"}\n`, `                            {item.displayName ?? item.nickName ?? t("會員")}\n`, 1],
  [`                        {member.displayName ?? "會員"}\n`, `                        {member.displayName ?? t("會員")}\n`, 1],
  // 搜尋結果標題（被 expression 斬碎）
  [
    `                      {t("搜尋結果（今次共 ")}{listTotal} {t("筆）")}<span className="ml-2 text-xs font-normal text-slate-400">\n                        {t("只係今次搜尋筆數，唔係全店總數")}\n                      </span>\n`,
    `                      {t("搜尋結果（今次共 {n} 筆）", { n: listTotal })}\n                      <span className="ml-2 text-xs font-normal text-slate-400">\n                        {t("只係今次搜尋筆數，唔係全店總數")}\n                      </span>\n`,
    1,
  ],
  [`                            {t("贈送 ")}{formatMoney(avosToMop(item.giftBalanceAvos))}\n`, `                            {t("贈送 {amt}", { amt: formatMoney(avosToMop(item.giftBalanceAvos)) })}\n`, 1],
  // 可核銷 N 張 · 共 M 張獎賞券
  [
    `                        {t("可核銷 ")}{grantGroups.active.length} {t("張 · 共 ")}{member.allGrants.length} {t("張獎賞券")}</div>\n`,
    `                        {t("可核銷 {a} 張 · 共 {b} 張獎賞券", {\n                          a: grantGroups.active.length,\n                          b: member.allGrants.length,\n                        })}\n                      </div>\n`,
    1,
  ],
  // 走 Ledger …… 冪等鍵防重複；契約明禁 ……。
  [
    `                        {t("走 Ledger")}{" "}\n                        <span className="font-mono">{\`merchant_apply_pos_txn(p_type:"topup")\`}</span>\n                        {t("，冪等鍵防重複；契約明禁")}{" "}\n                        <span className="font-mono">{\`p_type="add"\`}</span>。\n`,
    `                        {t("走 Ledger")}{" "}\n                        <span className="font-mono">{\`merchant_apply_pos_txn(p_type:"topup")\`}</span>\n                        {t("，冪等鍵防重複；契約明禁")}{" "}\n                        <span className="font-mono">{\`p_type="add"\`}</span>\n                        {t("。")}\n`,
    1,
  ],
  // {phone} 尚未註冊會員通
  [
    `                  <div className="text-sm font-semibold text-slate-900">{phone} {t("尚未註冊會員通")}</div>\n`,
    `                  <div className="text-sm font-semibold text-slate-900">\n                    {t("{phone} 尚未註冊會員通", { phone })}\n                  </div>\n`,
    1,
  ],
  // 建檔說明（被兩個 <span className="font-mono"> 斬碎）
  [
    `                    {t("輸入充值金額後撳「建檔並充值」，即會建立會員並完成首充（Ledger v3.2 §5.9")}<span className="font-mono"> ensure-customer</span>{t("，POS 伺服器代打）。 建檔後顧客須自行到會員通")}<span className="font-mono"> /wallet/login </span>\n                    {t("自設 4 位 PIN；POS 唔幫設 PIN。")}</div>\n`,
    `                    {t("輸入充值金額後撳「建檔並充值」，即會建立會員並完成首充（Ledger v3.2 §5.9")}\n                    <span className="font-mono"> ensure-customer</span>\n                    {t("，POS 伺服器代打）。建檔後顧客須自行到會員通")}\n                    <span className="font-mono"> /wallet/login </span>\n                    {t("自設 4 位 PIN；POS 唔幫設 PIN。")}\n                  </div>\n`,
    1,
  ],
  // 充值結果 toast（已填值字串 → key + vars）
  [
    `          text: \`已為 \${member?.displayName ?? "會員"} 充值 \${formatMoney(mop)}\`,\n`,
    `          text: t("已為 {name} 充值 {amount}", {\n            name: member?.displayName ?? t("會員"),\n            amount: formatMoney(mop),\n          }),\n`,
    1,
  ],
  [
    `          text: \`已為 \${targetPhone} 建立會員並充值 \${formatMoney(mop)}；請顧客到會員通 /wallet/login 自設 4 位 PIN。\`,\n`,
    `          text: t("已為 {phone} 建立會員並充值 {amount}；請顧客到會員通 /wallet/login 自設 4 位 PIN。", {\n            phone: targetPhone,\n            amount: formatMoney(mop),\n          }),\n`,
    1,
  ],
  // ⚠️ FixedNumberPad 嘅 `title` / `subtitle` 係 raw render（要喺呼叫點譯），
  //    而 `confirmLabel` 係內部 t(confirmLabel)（呼叫點一定要傳原文）——
  //    codemod 已經處理好，呢度唔再改。
]);

console.log(WRITE ? (fails ? `\n❌ ${fails} 個 edit 冇命中` : "\n✅ 全部命中，已落盤") : "\n（dry-run）");
process.exit(fails ? 1 : 0);
