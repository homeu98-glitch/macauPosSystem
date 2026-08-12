import { renderKitchenTicket, renderReceiptTicket, renderTestPage } from "./escpos.mjs";
import { printToLan } from "./lan-printer.mjs";
import { printToUsb } from "./usb-printer.mjs";

/**
 * @param {import('./types.mjs').BridgePrinter} printer
 * @param {Buffer} data
 */
export async function sendRawToPrinter(printer, data) {
  if (printer.connectionType === "usb") {
    await printToUsb({ printerName: printer.usbLabel || printer.name, data });
    return;
  }

  await printToLan({
    host: printer.ipAddress,
    port: printer.lanPort ?? 9100,
    data,
  });
}

/**
 * @param {{ job: import('./types.mjs').BridgePrintJob, printer: import('./types.mjs').BridgePrinter, deviceConfig?: import('./types.mjs').BridgeDeviceConfig | null, meta?: Record<string, unknown> }} input
 */
export async function dispatchPrintJob({ job, printer, deviceConfig, meta }) {
  if (!printer?.enabled) {
    throw new Error(`打印機「${printer?.name ?? job.printerName}」未啟用。`);
  }

  let payload;
  if (printer.role === "receipt") {
    payload = renderReceiptTicket({
      job,
      printer,
      storeName: deviceConfig?.terminalName,
      paymentMethod: typeof meta?.paymentMethod === "string" ? meta.paymentMethod : undefined,
      total: typeof meta?.total === "number" ? meta.total : undefined,
    });
  } else {
    payload = renderKitchenTicket({
      job,
      printer,
      storeName: deviceConfig?.terminalName,
    });
  }

  await sendRawToPrinter(printer, payload);
}

export async function dispatchTestPrint({ printer, deviceConfig }) {
  const payload = renderTestPage({ printer, storeName: deviceConfig?.terminalName });
  await sendRawToPrinter(printer, payload);
}
