"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { defaultDeviceConfig } from "@/lib/mock-data";
import { loadDeviceConfig, saveDeviceConfig, saveQueue, loadQueue } from "@/lib/storage";
import { DeviceConfig, DevicePrinterConfig, QueueEvent } from "@/lib/types";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function DeviceSettings() {
  const cachedConfig = loadDeviceConfig();
  const [config, setConfig] = useState<DeviceConfig>(cachedConfig ?? defaultDeviceConfig);
  const [status, setStatus] = useState(cachedConfig ? "已載入本機設定。" : "尚未同步設定。");

  useEffect(() => {
    if (!cachedConfig) {
      saveDeviceConfig(defaultDeviceConfig);
    }
  }, [cachedConfig]);

  function updatePrinter(printerId: string, patch: Partial<DevicePrinterConfig>) {
    setConfig((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      printers: current.printers.map((printer) =>
        printer.id === printerId ? { ...printer, ...patch } : printer,
      ),
    }));
  }

  function saveLocal() {
    saveDeviceConfig(config);
    setStatus("已保存到本機，尚未回寫後台。");
  }

  async function syncConfig() {
    const updatedConfig = { ...config, updatedAt: new Date().toISOString() };
    saveDeviceConfig(updatedConfig);
    setConfig(updatedConfig);

    const event: QueueEvent = {
      id: uid("evt"),
      type: "DEVICE_CONFIG_UPDATED",
      entityId: updatedConfig.deviceId,
      payload: updatedConfig,
      status: "pending",
      createdAt: updatedConfig.updatedAt,
    };

    const nextQueue = [...loadQueue(), event];
    saveQueue(nextQueue);

    try {
      await fetch("/api/pos/device-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedConfig),
      });
      saveQueue(nextQueue.map((item) => (item.id === event.id ? { ...item, status: "synced" } : item)));
      setStatus("已同步到後台設定接口。");
    } catch {
      setStatus("同步失敗，已保留在本機待補傳。");
    }
  }

  async function testPrint(printer: DevicePrinterConfig) {
    const event: QueueEvent = {
      id: uid("evt"),
      type: "TEST_PRINT_REQUESTED",
      entityId: printer.id,
      payload: {
        printerId: printer.id,
        printerName: printer.name,
        connectionType: printer.connectionType,
      },
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    const nextQueue = [...loadQueue(), event];
    saveQueue(nextQueue);

    try {
      await fetch("/api/pos/device-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test-print",
          printerId: printer.id,
          printerName: printer.name,
        }),
      });
      saveQueue(nextQueue.map((item) => (item.id === event.id ? { ...item, status: "synced" } : item)));
      setStatus(`已送出 ${printer.name} 測試打印。`);
    } catch {
      setStatus(`未能送出 ${printer.name} 測試打印，事件已排隊。`);
    }
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="sticky top-0 z-20 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-4 py-3">
          <div>
            <div className="text-lg font-semibold text-slate-900">設備與打印設定</div>
            <div className="mt-1 text-sm text-slate-500">
              只處理本機打印機綁定（LAN / USB），收銀規則由主系統下發。
            </div>
          </div>
          <Link className="rounded-full bg-indigo-600 px-3 py-2 text-sm font-semibold text-white" href="/">
            返回收銀台
          </Link>
        </div>
      </div>

      <div className="mx-auto max-w-[1440px] px-4 py-3">
        <div className="grid gap-3 lg:grid-cols-[1fr_1.2fr]">
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">本機資料</h2>
                <p className="mt-1 text-sm text-slate-500">{status}</p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                updated {config.updatedAt.slice(11, 16)}
              </span>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                <span className="text-xs text-slate-500">設備 ID</span>
                <input
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-indigo-500"
                  onChange={(event) => setConfig((current) => ({ ...current, deviceId: event.target.value }))}
                  value={config.deviceId}
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                <span className="text-xs text-slate-500">收銀機名稱</span>
                <input
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-indigo-500"
                  onChange={(event) =>
                    setConfig((current) => ({ ...current, terminalName: event.target.value }))
                  }
                  value={config.terminalName}
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                <span className="text-xs text-slate-500">門店 ID</span>
                <input
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-indigo-500"
                  onChange={(event) => setConfig((current) => ({ ...current, storeId: event.target.value }))}
                  value={config.storeId}
                />
              </label>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                onClick={saveLocal}
                type="button"
              >
                只保存到本機
              </button>
              <button
                className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
                onClick={syncConfig}
                type="button"
              >
                保存並同步後台
              </button>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">打印機綁定</h2>
                <p className="mt-1 text-sm text-slate-500">
                  這裡改的是本機設備綁定，會回寫後台保存（避免多設備時混亂）。
                </p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                {config.printers.length} printers
              </span>
            </div>

            <div className="mt-4 grid gap-3">
              {config.printers.map((printer) => (
                <article key={printer.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">{printer.name}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {printer.group} · {printer.connectionType.toUpperCase()}
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                      <input
                        checked={printer.enabled}
                        onChange={(event) => updatePrinter(printer.id, { enabled: event.target.checked })}
                        type="checkbox"
                      />
                      啟用
                    </label>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1 text-sm font-semibold text-slate-700">
                      <span className="text-xs text-slate-500">打印機名稱</span>
                      <input
                        className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-indigo-500"
                        onChange={(event) => updatePrinter(printer.id, { name: event.target.value })}
                        value={printer.name}
                      />
                    </label>
                    <label className="grid gap-1 text-sm font-semibold text-slate-700">
                      <span className="text-xs text-slate-500">連接方式</span>
                      <select
                        className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-indigo-500"
                        onChange={(event) =>
                          updatePrinter(printer.id, {
                            connectionType: event.target.value as DevicePrinterConfig["connectionType"],
                          })
                        }
                        value={printer.connectionType}
                      >
                        <option value="lan">LAN</option>
                        <option value="usb">USB</option>
                      </select>
                    </label>
                    <label className="grid gap-1 text-sm font-semibold text-slate-700">
                      <span className="text-xs text-slate-500">IP 地址（LAN）</span>
                      <input
                        className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-indigo-500"
                        onChange={(event) => updatePrinter(printer.id, { ipAddress: event.target.value })}
                        placeholder="192.168.1.110"
                        value={printer.ipAddress ?? ""}
                      />
                    </label>
                    <label className="grid gap-1 text-sm font-semibold text-slate-700">
                      <span className="text-xs text-slate-500">USB 標籤（USB）</span>
                      <input
                        className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-indigo-500"
                        onChange={(event) => updatePrinter(printer.id, { usbLabel: event.target.value })}
                        placeholder="USB-Receipt-01"
                        value={printer.usbLabel ?? ""}
                      />
                    </label>
                  </div>

                  <div className="mt-4 flex justify-end">
                    <button
                      className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                      onClick={() => testPrint(printer)}
                      type="button"
                    >
                      測試打印
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
