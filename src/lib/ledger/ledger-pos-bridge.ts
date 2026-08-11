"use client";

import { LedgerOnlineOrder } from "@/lib/ledger/order-mapper";
import { getOrderDetail, LedgerOrderDetail } from "@/lib/ledger/orders";
import { defaultDeviceConfig } from "@/lib/mock-data";
import {
  loadBootstrapCache,
  loadDeviceConfig,
  loadOrders,
  loadPrintJobs,
  saveOrders,
  savePrintJobs,
} from "@/lib/storage";
import { OrderItem, PosBootstrap, PosOrder, PrintJob } from "@/lib/types";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function resolveTableMeta(order: LedgerOnlineOrder, tableId?: string, tableName?: string) {
  if (order.tabType === "dine_in" && tableId && tableName) {
    return { tableId, tableName };
  }
  if (order.tabType === "pickup") {
    return { tableId: "counter", tableName: "自取" };
  }
  if (order.tabType === "self_delivery") {
    return { tableId: "counter", tableName: "外賣" };
  }
  return { tableId: "counter", tableName: "堂食" };
}

function mapDetailToOrderItems(
  detail: LedgerOrderDetail,
  bootstrap: PosBootstrap | null,
): OrderItem[] {
  return detail.items.map((item) => {
    const menu = bootstrap?.menuItems.find(
      (row) => row.name === item.name || row.id === item.menuItemId,
    );
    return {
      menuItemId: menu?.id ?? item.menuItemId ?? `ext-${item.name}`,
      name: item.name,
      quantity: item.qty,
      price: item.unitPrice ?? menu?.price ?? 0,
      printerGroup: menu?.printerGroup ?? "kitchen",
      note: item.note,
    };
  });
}

function buildPrintJobs(order: PosOrder): PrintJob[] {
  const configuredPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter((printer) => printer.enabled);
  const timestamp = new Date().toISOString();

  return configuredPrinters
    .filter(
      (printer) =>
        (printer.role === "zone" || printer.role === "label") &&
        order.items.some((item) => item.printerGroup === (printer.zoneId ?? "")),
    )
    .map<PrintJob>((printer) => ({
      id: uid("print"),
      orderId: order.id,
      orderNo: order.localOrderNo,
      tableName: order.tableName,
      ticketType: "normal",
      printerGroup: printer.zoneId ?? "",
      printerName: printer.name,
      items: order.items
        .filter((item) => item.printerGroup === (printer.zoneId ?? ""))
        .map((item) => ({
          name: item.name,
          quantity: item.quantity,
          specs: (item.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
          note: item.note,
        })),
      status: "pending",
      createdAt: timestamp,
    }));
}

export type BridgeLedgerOrderOptions = {
  ledgerOrder: LedgerOnlineOrder;
  tableId?: string;
  tableName?: string;
  detail?: LedgerOrderDetail;
};

export async function bridgeLedgerOrderToPos(options: BridgeLedgerOrderOptions): Promise<{
  posOrder: PosOrder;
  printJobs: PrintJob[];
}> {
  const bootstrap = loadBootstrapCache();
  const detail = options.detail ?? (await getOrderDetail(options.ledgerOrder.id));
  const { tableId, tableName } = resolveTableMeta(options.ledgerOrder, options.tableId, options.tableName);
  const items = mapDetailToOrderItems(detail, bootstrap);
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const taxRate = bootstrap?.rules.taxRate ?? 0;
  const serviceRate = bootstrap?.rules.serviceChargeRate ?? 0;
  const taxAmount = subtotal * taxRate;
  const serviceChargeAmount = subtotal * serviceRate;
  const total = subtotal + taxAmount + serviceChargeAmount;
  const timestamp = new Date().toISOString();
  const localOrderNo =
    options.ledgerOrder.pickupCode ??
    (options.ledgerOrder.tabType === "pickup"
      ? `自取-${options.ledgerOrder.id.slice(0, 6)}`
      : options.ledgerOrder.tabType === "self_delivery"
        ? `外送-${options.ledgerOrder.id.slice(0, 6)}`
        : `線上-${options.ledgerOrder.id.slice(0, 6)}`);

  const posOrder: PosOrder = {
    id: `ledger-${options.ledgerOrder.id}`,
    localOrderNo,
    tableId,
    tableName,
    status: "sent_to_kitchen",
    fulfillmentStatus: "preparing",
    items,
    orderNote: options.ledgerOrder.note,
    subtotal,
    taxAmount,
    serviceChargeAmount,
    discountAmount: 0,
    total: detail.total ?? options.ledgerOrder.total,
    prepaidAmount: options.ledgerOrder.paymentStatus === "paid" ? options.ledgerOrder.total : 0,
    onlineOrderId: options.ledgerOrder.id,
    paymentMethod: options.ledgerOrder.paymentMode,
    createdAt: options.ledgerOrder.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  const printJobs = buildPrintJobs(posOrder);
  const existingOrders = loadOrders();
  const nextOrders = [posOrder, ...existingOrders.filter((row) => row.id !== posOrder.id)];
  saveOrders(nextOrders);

  if (printJobs.length > 0) {
    savePrintJobs([...printJobs, ...loadPrintJobs()]);
  }

  return { posOrder, printJobs };
}
