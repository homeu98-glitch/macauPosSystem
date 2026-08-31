"use client";

import {
  appendPrintJobs,
  buildKioskReceiptPrintJobs,
  buildKitchenPrintJobs,
  buildLabelPrintJobs,
  buildReopenPrintJobs,
} from "@/lib/print-jobs";
import { isSelfOrder } from "@/lib/pos/order-source";
import { TEMP_REOPEN_ID_PREFIX } from "@/lib/pos/table-scope";
import {
  loadBootstrapCache,
  loadOrders,
  loadPosLocalSettings,
  loadQueue,
  saveOrders,
  savePosLocalSettings,
  saveQueue,
} from "@/lib/storage";
import { FloorConfig, PosOrder, QueueEvent, StoreTable } from "@/lib/types";

/**
 * 可返結：只可對「已結帳」（settled / paid）嘅單返結。
 *
 * 線上單分兩種：
 * - 純線上快餐 / 自取 / 外賣（onlineOrderId 存在，且未轉枱 = tableId 係 counter 或無枱）：
 *   由上游 Ledger 對賬，POS 端唔支援返結。
 * - 「線上堂食單轉到枱」（onlineOrderId 存在 + tableId 唔係 counter）：
 *   已變成喺店堂食單，當本地單處理，可以返結。
 * 美容同其他本地單無 onlineOrderId，一律當本地單。
 */
export function isReopenable(order: PosOrder): boolean {
  // 快餐（本地 counter 單）唔支援返結
  const isQuickCounter = !order.onlineOrderId && order.tableId === "counter";
  if (isQuickCounter) return false;
  if (order.onlineOrderId) {
    const isInStoreDineIn = !!order.tableId && order.tableId !== "counter";
    if (!isInStoreDineIn) return false; // 純線上快餐 / 自取 / 外賣
  }
  return order.status === "settled" || order.status === "paid";
}

export type ReopenResult = {
  ok: boolean;
  error?: string;
  /** 會員餘額是否成功反向加回（best-effort） */
  memberReversed?: boolean;
  /** add RPC 失敗原因（不阻擋返結，僅標記） */
  memberReverseError?: string;
  /** 返結後嘅 temp 枱（結帳／取消後移除）；冇 floors 時為 undefined（降級：原枱直接變可編輯） */
  tempTable?: ReopenTempTable;
  /** 返結後嘅訂單（tableId 已轉去 temp 枱） */
  order?: PosOrder;
};

/** 返結 temp 枱：只喺編輯期間存在，結帳／取消後移除 */
export type ReopenTempTable = {
  id: string;
  name: string;
  area: string;
  floorId: string;
};

function findFloorContainingTable(floors: FloorConfig[], tableId: string): FloorConfig | null {
  return floors.find((floor) => floor.tables.some((table) => table.id === tableId)) ?? null;
}

/**
 * 為返結單建立一張 temp 枱（放喺原枱所屬 floor），令原枱唔會被「取代」。
 * 唔支援多枱 / 無 floors 時降級：用 floors[0]，再無就新建一個 "返結枱" floor。
 * 建立後寫入 localSettings.floors 並 dispatch 事件，pos-app 會即時刷新枱面。
 *
 * ⚠️ temp 枱係 push 入 `localSettings.floors[].tables[]`（同真實枱共用 collection），
 * 生命週期只到結帳／取消（`removeReopenTempTable`）。**所有讀取 floors 嘅使用點，
 * 除咗枱面 view，都要用 `isReopenTempTable` / `stripReopenTempTables` filter 走**，
 * 否則 temp 枱會俾 admin 改名、產生掃碼 QR、派線上單，甚至寫上 server
 * `pos_bootstrap_config.tables` 永久升級做真實枱。見 `pos/table-scope.ts`。
 */
function createReopenTempTable(order: PosOrder): ReopenTempTable | null {
  const settings = loadPosLocalSettings();
  const floors = settings.floors?.length ? settings.floors : [];

  let targetFloor: FloorConfig;
  let nextFloors: FloorConfig[];
  const matched = findFloorContainingTable(floors, order.tableId);
  if (matched) {
    targetFloor = matched;
    nextFloors = floors;
  } else if (floors.length > 0) {
    targetFloor = floors[0];
    nextFloors = floors;
  } else {
    targetFloor = { id: "reopen-floor", name: "返結枱", tables: [] };
    nextFloors = [targetFloor];
  }

  const id = `${TEMP_REOPEN_ID_PREFIX}${order.id}`;
  const name = `返結 ${order.tableName || order.localOrderNo}`;
  const area = `返結·${targetFloor.name}`;
  const tempTable: StoreTable = {
    id,
    name,
    area,
    floorId: targetFloor.id,
    isReopenTemp: true,
    reopenOrderId: order.id,
  };

  const updatedFloors = nextFloors.map((floor) =>
    floor.id === targetFloor.id ? { ...floor, tables: [...floor.tables, tempTable] } : floor,
  );
  const updatedSettings = { ...settings, floors: updatedFloors };
  savePosLocalSettings(updatedSettings);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("pos-local-settings-changed", { detail: { localSettings: updatedSettings } }),
    );
  }

  return { id, name, area, floorId: targetFloor.id };
}

/** 結帳／取消後移除返結 temp 枱（按 reopenOrderId 配對） */
export function removeReopenTempTable(orderId: string) {
  const settings = loadPosLocalSettings();
  const floors = settings.floors ?? [];
  const hasTemp = floors.some((floor) => floor.tables.some((table) => table.reopenOrderId === orderId));
  if (!hasTemp) return;
  const updatedFloors = floors.map((floor) => ({
    ...floor,
    tables: floor.tables.filter((table) => table.reopenOrderId !== orderId),
  }));
  const updatedSettings = { ...settings, floors: updatedFloors };
  savePosLocalSettings(updatedSettings);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("pos-local-settings-changed", { detail: { localSettings: updatedSettings } }),
    );
  }
}

/**
 * 餐飲返結（反結賬）：把已結單退回可編輯狀態。
 *
 * 1. 強制原因（reason 不可空白）。
 * 2. 狀態切到 `reopened` + 寫審計（reopenedAt / reopenedBy / reopenReason / reopenCount / originalSettledAt）。
 * 3. 反向回滾會員餘額（best-effort：若 Ledger add RPC 尚未佈署，只記警告並繼續切狀態）。
 * 4. 印「返結單」到各區域 / 標籤機。
 * 5. dispatch `pos-orders-changed` 通知訂單面板刷新。
 *
 * 重結由 POS 工作台（pos-app confirmPayment）針對同一 order.id 重新落單結帳完成。
 */
export async function reopenPosOrder(params: {
  orderId: string;
  reason: string;
  operator: string;
}): Promise<ReopenResult> {
  const reason = (params.reason ?? "").trim();
  if (!reason) {
    return { ok: false, error: "必須揀返結原因" };
  }

  const orders = loadOrders();
  const idx = orders.findIndex((o) => o.id === params.orderId);
  if (idx < 0) return { ok: false, error: "找不到訂單" };

  const order = orders[idx];
  if (!isReopenable(order)) {
    return { ok: false, error: "此單狀態不可返結（只可返結已結帳單）" };
  }

  // ① 反向回滾會員餘額：v3.2 契約規定 POS 店內單返結唔動 Ledger 餘額
  // （p_type="add" 唔開放 POS；真沖正請顧客用會員通 Web「退回」）。
  // 故只切換 POS 本機狀態，唔 call Ledger。
  const memberReversed = false;
  let memberReverseError: string | undefined;

  // ①.5 建立 temp 枱，將返結單由「原枱」搬到 temp 枱（原枱唔會被取代）
  const tempTable = createReopenTempTable(order);

  // ② 切狀態 + 寫審計
  const now = new Date().toISOString();
  const updated: PosOrder = {
    ...order,
    status: "reopened",
    // 搬到 temp 枱；記低原枱以便結帳後還原
    tableId: tempTable ? tempTable.id : order.tableId,
    tableName: tempTable ? tempTable.name : order.tableName,
    reopenOriginalTableId: tempTable ? order.tableId : order.reopenOriginalTableId,
    reopenOriginalTableName: tempTable ? order.tableName : order.reopenOriginalTableName,
    reopenedAt: now,
    reopenedBy: params.operator,
    reopenReason: reason,
    reopenCount: (order.reopenCount ?? 0) + 1,
    originalSettledAt: order.originalSettledAt ?? order.updatedAt,
    updatedAt: now,
  };

  const next = [...orders];
  next[idx] = updated;
  saveOrders(next);

  // ③ 印返結單
  appendPrintJobs(buildReopenPrintJobs(updated, reason, params.operator));

  // ④ 通知面板刷新
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pos-orders-changed"));
  }

  return { ok: true, memberReversed, memberReverseError, tempTable: tempTable ?? undefined, order: updated };
}

// ─────────────────────────────────────────────────────────────
// 自助單確認／拒絕（docs/87 §3、規格 5+6）
// ─────────────────────────────────────────────────────────────

export type ConfirmSelfOrderResult = {
  ok: boolean;
  error?: string;
  jobsCreated?: number;
};

/**
 * 確認自助單（kiosk / 掃碼落單）：把 draft 單推去 sent_to_kitchen，並建廚房單 + 標籤單。
 *
 * 複用收銀台正常落單流程（`upsertCurrentOrder("sent_to_kitchen")` + `buildKitchenPrintJobs()` +
 * `buildLabelPrintJobs()`），抽成共用函數供收銀台手動確認同自動流程呼叫（docs/87 §3.2）。
 */
export function confirmSelfOrder(orderId: string): ConfirmSelfOrderResult {
  const orders = loadOrders();
  const idx = orders.findIndex((o) => o.id === orderId);
  if (idx < 0) return { ok: false, error: "找不到訂單" };

  const order = orders[idx];
  if (!isSelfOrder(order)) {
    return { ok: false, error: "不是自助單" };
  }
  if (order.status !== "draft") {
    return { ok: false, error: "訂單狀態不是待確認" };
  }

  const now = new Date().toISOString();
  const updated: PosOrder = {
    ...order,
    status: "sent_to_kitchen",
    fulfillmentStatus: "preparing",
    sentToKitchenAt: now,
    updatedAt: now,
  };

  const next = [...orders];
  next[idx] = updated;
  saveOrders(next);

  // 建廚房單 + 標籤單（同 pos-app.tsx 正常落單流程一致）
  const bootstrap = loadBootstrapCache();
  const storeName = bootstrap?.storeName ?? "門店";
  const jobs = [
    ...buildKitchenPrintJobs(updated, { ticketType: "normal", storeName }),
    ...buildLabelPrintJobs(updated, { ticketType: "normal", storeName }),
  ];

  // 掃碼單補顧客小票（收銀端打印機出；Kiosk 本機已自己印咗）
  if (order.source === "scan" && bootstrap) {
    jobs.push(...buildKioskReceiptPrintJobs(updated, bootstrap));
  }

  appendPrintJobs(jobs);

  // 推同步事件（ORDER_UPDATED）
  const event: QueueEvent = {
    id: `evt-${crypto.randomUUID().slice(0, 8)}`,
    type: "ORDER_UPDATED",
    entityId: updated.id,
    payload: updated,
    status: "pending",
    createdAt: now,
  };
  const queue = loadQueue();
  saveQueue([event, ...queue]);

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pos-orders-changed"));
  }

  return { ok: true, jobsCreated: jobs.length };
}

/**
 * 拒絕自助單：把 draft 單標記為 cancelled。
 */
export function rejectSelfOrder(orderId: string, reason?: string): { ok: boolean; error?: string } {
  const orders = loadOrders();
  const idx = orders.findIndex((o) => o.id === orderId);
  if (idx < 0) return { ok: false, error: "找不到訂單" };

  const order = orders[idx];
  if (!isSelfOrder(order)) {
    return { ok: false, error: "不是自助單" };
  }
  if (order.status !== "draft") {
    return { ok: false, error: "訂單狀態不是待確認" };
  }

  const now = new Date().toISOString();
  const updated: PosOrder = {
    ...order,
    status: "cancelled",
    cancelledAt: now,
    cancelledReason: reason || "收銀台拒絕",
    updatedAt: now,
  };

  const next = [...orders];
  next[idx] = updated;
  saveOrders(next);

  const event: QueueEvent = {
    id: `evt-${crypto.randomUUID().slice(0, 8)}`,
    type: "ORDER_UPDATED",
    entityId: updated.id,
    payload: updated,
    status: "pending",
    createdAt: now,
  };
  const queue = loadQueue();
  saveQueue([event, ...queue]);

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pos-orders-changed"));
  }

  return { ok: true };
}
