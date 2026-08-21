import { PosOrder, PrintJob, PrinterGroup } from "@/lib/types";

/** `pos_orders` 資料表 row（snake_case）→ `PosOrder` 領域物件。
 *  映射與 `/api/pos/state/route.ts` 保持一致，作為收銀側 Realtime 訂閱嘅單一映射真源。 */
export interface PosOrderRow {
  id: string;
  local_order_no: string | null;
  store_id: string | null;
  table_id: string | null;
  table_name: string | null;
  status: string;
  fulfillment_status: string | null;
  items: PosOrder["items"];
  order_note: string | null;
  subtotal: number;
  tax_amount: number;
  service_charge_amount: number;
  discount_amount: number;
  total: number;
  prepaid_amount: number;
  online_order_id: string | null;
  payment_method: string | null;
  created_at: string;
  updated_at: string;
}

export function mapPosOrderRow(row: PosOrderRow): PosOrder {
  return {
    id: row.id,
    localOrderNo: row.local_order_no ?? row.id,
    tableId: row.table_id ?? "counter",
    tableName: row.table_name ?? "",
    status: (row.status as PosOrder["status"]) ?? "draft",
    fulfillmentStatus: (row.fulfillment_status as PosOrder["fulfillmentStatus"]) ?? undefined,
    items: Array.isArray(row.items) ? row.items : [],
    orderNote: row.order_note ?? undefined,
    subtotal: Number(row.subtotal ?? 0),
    taxAmount: Number(row.tax_amount ?? 0),
    serviceChargeAmount: Number(row.service_charge_amount ?? 0),
    discountAmount: Number(row.discount_amount ?? 0),
    total: Number(row.total ?? 0),
    prepaidAmount: Number(row.prepaid_amount ?? 0),
    onlineOrderId: row.online_order_id ?? undefined,
    paymentMethod: (row.payment_method as PosOrder["paymentMethod"]) ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** `pos_print_jobs` 資料表 row → `PrintJob`。 */
export interface PosPrintJobRow {
  id: string;
  store_id: string | null;
  order_id: string | null;
  order_no: string | null;
  table_name: string | null;
  ticket_type: string;
  printer_group: string;
  printer_name: string | null;
  items: PrintJob["items"];
  status: string;
  created_at: string;
}

export function mapPosPrintJobRow(row: PosPrintJobRow): PrintJob {
  return {
    id: row.id,
    orderId: row.order_id ?? "",
    orderNo: row.order_no ?? undefined,
    tableName: row.table_name ?? undefined,
    ticketType: (row.ticket_type as PrintJob["ticketType"]) ?? "normal",
    printerGroup: (row.printer_group as PrinterGroup) ?? "kitchen",
    printerName: row.printer_name ?? row.printer_group ?? "kitchen",
    items: Array.isArray(row.items) ? row.items : [],
    status: (row.status as PrintJob["status"]) ?? "pending",
    createdAt: row.created_at,
  };
}

/** `pos_soldout` 資料表 row（Kiosk 售罄即時標記）。 */
export interface PosSoldoutRow {
  id: string;
  store_id: string | null;
  menu_item_id: string;
  sold_out: boolean;
  updated_at: string;
}

export function mapPosSoldoutRow(row: PosSoldoutRow): PosSoldoutRow {
  return {
    id: row.id,
    store_id: row.store_id,
    menu_item_id: row.menu_item_id,
    sold_out: Boolean(row.sold_out),
    updated_at: row.updated_at,
  };
}
