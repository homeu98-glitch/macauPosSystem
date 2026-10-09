/**
 * orders 頁三個子元件 i18n 手改（2026-10-08）：
 *   · responsive-modal.tsx        —— closeLabel 預設「關閉」
 *   · table-assign-modal.tsx      —— 排位彈窗
 *   · scheduled-pickup-badge.tsx  —— 預約單標籤（會 render 落訂單列表）
 */
const fs = require("fs");
const path = require("path");

const ROOT = "C:/dev/macauPos/macauPosSystem";
const WRITE = process.argv.includes("--write");

let failed = 0;

function patch(rel, edits) {
  const p = path.join(ROOT, rel);
  let src = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  let bad = 0;
  for (const [find, replace, expect = 1] of edits) {
    const n = src.split(find).length - 1;
    if (n !== expect) {
      console.error(`❌ ${rel}: 出現 ${n} 次（預期 ${expect}）：${find.slice(0, 80).replace(/\n/g, "\\n")}`);
      bad++;
      continue;
    }
    src = src.split(find).join(replace);
  }
  if (bad) {
    failed += bad;
    return;
  }
  if (WRITE) {
    fs.writeFileSync(p, src.replace(/\n/g, "\r\n"));
    console.log(`✅ ${rel}（${edits.length} 條）`);
  } else {
    console.log(`dry-run OK：${rel}（${edits.length} 條）`);
  }
}

// ── responsive-modal.tsx ────────────────────────────────────────────────
patch("src/components/responsive-modal.tsx", [
  [
    `import { CSSProperties, ReactNode, Ref } from "react";`,
    `import { CSSProperties, ReactNode, Ref } from "react";\n\nimport { useT } from "@/components/lang-provider";`,
  ],
  [
    `  allowPointerEventsOnOverlay = true,\n}: ResponsiveModalProps) {\n  return (`,
    `  allowPointerEventsOnOverlay = true,\n}: ResponsiveModalProps) {\n  const t = useT();\n  return (`,
  ],
  [`                  {closeLabel}`, `                  {t(closeLabel)}`],
]);

// ── table-assign-modal.tsx ──────────────────────────────────────────────
patch("src/components/table-assign-modal.tsx", [
  [
    `import { ResponsiveModal } from "@/components/responsive-modal";`,
    `import { useT } from "@/components/lang-provider";\nimport { ResponsiveModal } from "@/components/responsive-modal";`,
  ],
  [
    `export function TableAssignModal({`,
    `/** 冇樓層名時嘅分組標題（同時係字典 key）。 */\nconst FLOOR_FALLBACK = "未分區";\n\nexport function TableAssignModal({`,
  ],
  [
    `  onSelect,\n  onClose,\n}: TableAssignModalProps) {\n  const grouped = useMemo(() => {`,
    `  onSelect,\n  onClose,\n}: TableAssignModalProps) {\n  const t = useT();\n  const grouped = useMemo(() => {`,
  ],
  [`      const key = table.floorName || "未分區";`, `      const key = table.floorName || FLOOR_FALLBACK;`],
  [
    `      description={description}`,
    `      {/* ⚠️ \`description\` 係顯示文案（字典 key）；call site 可能已經自己 t() 咗 ——\n          嗰時 t() 查唔到 key 會原樣返回，冇副作用。 */}\n      description={t(description)}`,
  ],
  [
    `        <div className="text-sm text-slate-500">尚未設定桌台，請至「設置 → 桌台」新增。</div>`,
    `        <div className="text-sm text-slate-500">{t("尚未設定桌台，請至「設置 → 桌台」新增。")}</div>`,
  ],
  [
    `              <div className="mb-2 text-xs font-semibold text-slate-500">{floorName}</div>`,
    `              {/* ⚠️ 唔可以 \`t(floorName)\` —— 真樓層名係第 2 層資料值，翻譯會壞功能。\n                  只翻「冇樓層名」嗰個 fallback。 */}\n              <div className="mb-2 text-xs font-semibold text-slate-500">\n                {floorName === FLOOR_FALLBACK ? t(FLOOR_FALLBACK) : floorName}\n              </div>`,
  ],
  [`                            {occupiedTableHint()}`, `                            {t(occupiedTableHint())}`],
  [`                        {busy ? "處理中…" : table.floorName}`, `                        {busy ? t("處理中…") : table.floorName}`],
]);

// ── scheduled-pickup-badge.tsx ──────────────────────────────────────────
patch("src/components/scheduled-pickup-badge.tsx", [
  [
    `import { formatMacauDateTime, formatMacauMonthDayTime } from "@/lib/format";`,
    `import { useT } from "@/components/lang-provider";\nimport { formatMacauDateTime, formatMacauMonthDayTime } from "@/lib/format";`,
  ],
  [
    `  scheduledPickupMinutesUntil,\n  scheduledPickupRelativeText,\n  scheduledPickupTimeClass,`,
    `  scheduledPickupMinutesUntil,\n  scheduledPickupRelativeParts,\n  scheduledPickupTimeClass,`,
  ],
  [`      {scheduledPickupChipText(kind)}`, `      {t(scheduledPickupChipText(kind))}`],
  [
    `}) {\n  const iso = order?.scheduledPickupAt;`,
    `}) {\n  const t = useT();\n  const iso = order?.scheduledPickupAt;`,
  ],
  [
    `  const relative =\n    full || kind === "closed" ? "" : scheduledPickupRelativeText(scheduledPickupMinutesUntil(iso, nowMs));`,
    `  // ⚠️ 用 \`scheduledPickupRelativeParts()\` 而唔係 \`...Text()\` —— 後者回已填值字串\n  //    （\`18 分鐘後\`），字典 key 係 \`{minutes} 分鐘後\`，t() 永遠命中唔到。\n  const relParts =\n    full || kind === "closed"\n      ? null\n      : scheduledPickupRelativeParts(scheduledPickupMinutesUntil(iso, nowMs));\n  const relative = relParts ? t(relParts.key, relParts.vars) : "";`,
  ],
  [
    `      {full ? \`預約時間：\${timeText}\` : \`預約 \${timeText}\`}`,
    `      {full\n        ? t("預約時間：{time}", { time: timeText })\n        : t("預約 {time}", { time: timeText })}`,
  ],
]);

if (failed) {
  console.error(`\n❌ ${failed} 條問題，未寫入`);
  process.exit(1);
}
console.log(WRITE ? "\n✅ 完成" : "\n（dry-run，加 --write 才落盤）");
