"use client";

/**
 * 訂位紙本單 —— 確認單（一張訂位）／今日清單（成日）。
 *
 * ## 為什麼「借用」交班單模板
 *
 * 打印通道（Hub / Companion / 中繼 APK）只認得 `template.kind` 那五種，
 * 而且**冇 `template` 快照就會 fallback 去 `renderKitchenTicket()`**，
 * 硬印「＊＊＊ 廚房 ＊＊＊」、每後面加 `x1`、完全唔理 content（docs/103 血淚）。
 *
 * 加一種新 `PrintKind = "reservation"` 要改三個 repo 嘅 renderer ＋設定頁 ＋契約測試，
 * 呢一輪唔值得。交班單（shift）本質就係「一堆結構化文字區塊、冇 items」，
 * 同訂位單**完全同構**，所以：
 *
 * - `kind: "shift"`、`template.kind: "shift"`、`items: []`
 * - content 用 shift 既有嘅合法 section id（`header` / `store_name` / `note` …）
 * - 用 `normalizeShiftTemplate(null)` 出廠模板，**唔讀商家交班單設定**
 *   （商家改交班單字型唔應該連訂位單都變）
 *
 * 代價：打印中心會把呢張單歸類做「交班單」，但出紙內容完全正確。
 * 將來要獨立分類，再加 `PrintKind` 就得，builder 唔使改。
 *
 * ## 🔴 content 一定要補齊所有 section id
 *
 * renderer 逐個 `visible` block 查 `content[id]`；遇到 `undefined` 有機會印出
 * 字串 `"undefined"`。所以下面用 `SHIFT_SECTION_META` 先鋪一份全空字串，
 * 再覆寫要用嘅幾格 —— 唔可以只畀部份 key。
 *
 * ## 🔴 手動列印唔寫 onceKey
 *
 * 店員撳幾次要印幾張（補印／換紙），所以一律唔帶 `onceKey`
 * （見 `print-dedupe.ts` 檔頭）。
 */

import {
  buildSnapshot,
  normalizeShiftTemplate,
  paperColumnsFromSize,
  SHIFT_SECTION_META,
} from "@/lib/escpos-template";
import { appendPrintJobsWithSync } from "@/lib/pos/print-job-enqueue";
import { loadDeviceConfig } from "@/lib/storage";
import type { DevicePrinterConfig, PrintJob } from "@/lib/types";
import type { PosReservation } from "./types.ts";

export type ReservationPrintContext = {
  storeId: string;
  storeName: string;
  /** 商家自訂訂位須知，印喺頁尾。 */
  notice?: string | null;
};

const STATUS_TEXT: Record<string, string> = {
  pending: "待確認",
  confirmed: "已確認",
  arrived: "已到店",
  seated: "已入座",
  completed: "已完成",
  canceled: "已取消",
  no_show: "未到",
  waitlist: "候補",
};

/** 澳門固定 UTC+8，無夏令時。 */
function macauDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ${p(
    shifted.getUTCHours(),
  )}:${p(shifted.getUTCMinutes())}`;
}

/** 全空 content 基底，保證每個 section id 都有 key。 */
function emptyShiftContent(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { id } of SHIFT_SECTION_META) out[id] = "";
  return out;
}

function receiptPrinter(): DevicePrinterConfig | null {
  const config = loadDeviceConfig();
  const printers = config?.printers ?? [];
  return (
    printers.find((p) => p.role === "receipt" || p.roles?.includes("receipt")) ??
    printers[0] ??
    null
  );
}

function makeJob(args: {
  ctx: ReservationPrintContext;
  orderId: string;
  orderNo: string;
  content: Record<string, string>;
}): PrintJob {
  const printer = receiptPrinter();
  const template = buildSnapshot(
    "shift",
    normalizeShiftTemplate(null),
    paperColumnsFromSize(printer?.paperSize),
  );
  return {
    id: `print-${crypto.randomUUID().slice(0, 8)}`,
    orderId: args.orderId,
    orderNo: args.orderNo,
    tableName: "",
    ticketType: "normal",
    // 下游三個 renderer 都認得 "shift"；template.kind 亦要一致，否則快照丟失時會猜錯。
    kind: "shift",
    printerGroup: "receipt",
    printerId: printer?.id,
    printerName: printer?.name ?? "收據打印機",
    storeId: args.ctx.storeId,
    items: [],
    content: args.content,
    template,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

function itemsText(reservation: PosReservation): string[] {
  if (reservation.items.length === 0) return [];
  const lines = reservation.items.map((item) => {
    const spec = item.specText ? `（${item.specText}）` : "";
    return `  ${item.name}${spec} x${item.qty}`;
  });
  lines.push(`  預點參考金額 $${reservation.payableAmount.toFixed(2)}（以到店當日菜牌為準）`);
  return lines;
}

/** 一張訂位嘅確認單：客人資料 + 時間 + 預點菜。 */
export function buildReservationConfirmJob(
  reservation: PosReservation,
  ctx: ReservationPrintContext,
): PrintJob {
  const content = emptyShiftContent();
  content.header = "訂位確認單";
  content.store_name = ctx.storeName;
  content.shift_no = `訂位碼：${reservation.code}`;
  content.employee = `狀態：${STATUS_TEXT[reservation.status] ?? reservation.status}`;
  content.close_time = `訂位時間：${macauDateTime(reservation.slotAt)}`;
  content.open_time = `人數：${reservation.partySize} 位${reservation.tableName ? `　枱位：${reservation.tableName}` : ""}`;

  const notes: string[] = [];
  if (reservation.guestName) notes.push(`客人：${reservation.guestName}`);
  if (reservation.guestPhone) notes.push(`電話：${reservation.guestPhone}`);
  if (reservation.guestNote) notes.push(`備註：${reservation.guestNote}`);
  const pre = itemsText(reservation);
  if (pre.length > 0) {
    notes.push(`預點菜 ${reservation.items.length} 道：`, ...pre);
  }
  content.note = notes.join("\n");
  content.footer = ctx.notice?.trim() || "請準時到店，如需更改請致電商家。";

  return makeJob({
    ctx,
    orderId: `reservation-${reservation.id}`,
    orderNo: `訂位 ${reservation.code}`,
    content,
  });
}

/** 全日訂位清單：按時間排序，一張訂位一行，方便帶位員拎住紙對。 */
export function buildReservationDayListJob(
  reservations: PosReservation[],
  dateLabel: string,
  ctx: ReservationPrintContext,
): PrintJob {
  const active = reservations
    .filter((r) => r.status !== "canceled" && r.status !== "no_show")
    .sort((a, b) => a.slotAt.localeCompare(b.slotAt));
  const guests = active.reduce((sum, r) => sum + r.partySize, 0);

  const content = emptyShiftContent();
  content.header = "今日訂位清單";
  content.store_name = ctx.storeName;
  content.shift_no = `日期：${dateLabel}`;
  content.employee = `合計 ${active.length} 組 / ${guests} 位`;
  content.close_time = `列印時間：${macauDateTime(new Date().toISOString())}`;

  const lines =
    active.length === 0
      ? ["（本日暫無訂位）"]
      : active.map((r) => {
          const hm = macauDateTime(r.slotAt).slice(11);
          const pre = r.items.length > 0 ? ` 預點${r.items.length}道` : "";
          const tbl = r.tableName ? ` ${r.tableName}` : "";
          const paid = r.paidAmount > 0 ? " 已付" : "";
          return `${hm}  ${r.guestName || "—"}  ${r.partySize}位${tbl}${pre}${paid}  [${
            STATUS_TEXT[r.status] ?? r.status
          }]`;
        });
  content.note = lines.join("\n");
  content.footer = "";

  return makeJob({
    ctx,
    orderId: `reservations-day-${dateLabel}-${Date.now()}`,
    orderNo: `訂位清單 ${dateLabel}`,
    content,
  });
}

/** 出紙唯一入口：落本機 + 推上雲，兩步都要做齊（見 `print-job-enqueue.ts` 檔頭）。 */
export function printReservationJobs(jobs: PrintJob[]): number {
  return appendPrintJobsWithSync(jobs);
}
