import printerModule from "printer";

/**
 * @param {{ printerName: string, data: Buffer }} options
 */
export function printToUsb({ printerName, data }) {
  return new Promise((resolve, reject) => {
    if (!printerName) {
      reject(new Error("USB 打印機缺少系統印表機名稱（usbLabel）。"));
      return;
    }

    printerModule.printDirect({
      data,
      printer: printerName,
      type: "RAW",
      success: (jobId) => resolve(jobId),
      error: (error) => reject(error instanceof Error ? error : new Error(String(error))),
    });
  });
}

export function listSystemPrinters() {
  try {
    return printerModule.getPrinters().map((row) => ({
      name: row.name,
      isDefault: Boolean(row.isDefault),
      status: row.status,
    }));
  } catch (error) {
    return [];
  }
}
