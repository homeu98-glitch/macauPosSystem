"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { defaultDeviceConfig, defaultPosLocalSettings } from "@/lib/mock-data";
import { InputPadModal } from "@/components/input-pad-modal";
import {
  loadDeviceConfig,
  loadPosLocalSettings,
  loadQueue,
  saveDeviceConfig,
  savePosLocalSettings,
  saveQueue,
} from "@/lib/storage";
import { DeviceConfig, DevicePrinterConfig, PosLocalSettings, QueueEvent } from "@/lib/types";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function DeviceSettings() {
  const cachedConfig = loadDeviceConfig();
  const cachedLocalSettings = loadPosLocalSettings();
  const [config, setConfig] = useState<DeviceConfig>(cachedConfig ?? defaultDeviceConfig);
  const [localSettings, setLocalSettings] = useState<PosLocalSettings>(cachedLocalSettings ?? defaultPosLocalSettings);
  const [status, setStatus] = useState(cachedConfig ? "已載入本機設定。" : "尚未同步設定。");
  const [activeTab, setActiveTab] = useState<"device" | "tables" | "payments">("device");
  const [padOpen, setPadOpen] = useState(false);
  const [padMode, setPadMode] = useState<"number" | "text">("text");
  const [padTitle, setPadTitle] = useState("");
  const [padValue, setPadValue] = useState("");
  const [padApply, setPadApply] = useState<(value: string) => void>(() => () => {});

  useEffect(() => {
    if (!cachedConfig) {
      saveDeviceConfig(defaultDeviceConfig);
    }
    savePosLocalSettings(cachedLocalSettings ?? defaultPosLocalSettings);
  }, [cachedConfig, cachedLocalSettings]);

  function openPad(
    title: string,
    mode: "number" | "text",
    value: string,
    apply: (nextValue: string) => void,
  ) {
    setPadTitle(title);
    setPadMode(mode);
    setPadValue(value);
    setPadApply(() => apply);
    setPadOpen(true);
  }

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
    savePosLocalSettings(localSettings);
    setStatus("已保存到本機，尚未回寫後台。");
  }

  async function syncConfig() {
    const updatedConfig = { ...config, updatedAt: new Date().toISOString() };
    saveDeviceConfig(updatedConfig);
    savePosLocalSettings(localSettings);
    setConfig(updatedConfig);

    const event: QueueEvent = {
      id: uid("evt"),
      type: "DEVICE_CONFIG_UPDATED",
      entityId: updatedConfig.deviceId,
      payload: {
        device: updatedConfig,
        tables: localSettings.floors,
        paymentMethods: localSettings.paymentMethods,
      },
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
          <div className="text-lg font-semibold text-slate-900">設置</div>
            <div className="mt-1 text-sm text-slate-500">
              可管理打印機、樓層/桌台與支付方式。收銀規則仍然來自主系統。
            </div>
          </div>
          <Link className="rounded-full bg-indigo-600 px-3 py-2 text-sm font-semibold text-white" href="/">
            返回收銀台
          </Link>
        </div>
      </div>

      <div className="mx-auto max-w-[1440px] px-4 py-3">
        <div className="mb-3 flex flex-wrap gap-2">
          {[
            ["device", "打印機"],
            ["tables", "樓層與桌台"],
            ["payments", "支付方式"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                activeTab === key ? "bg-orange-500 text-white" : "bg-white text-slate-700 ring-1 ring-slate-200"
              }`}
              onClick={() => setActiveTab(key as "device" | "tables" | "payments")}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>

        {activeTab === "device" ? (
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
                  readOnly
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-indigo-500"
                  onClick={() =>
                    openPad("設備 ID", "text", config.deviceId, (value) =>
                      setConfig((current) => ({ ...current, deviceId: value })),
                    )
                  }
                  value={config.deviceId}
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                <span className="text-xs text-slate-500">收銀機名稱</span>
                <input
                  readOnly
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-indigo-500"
                  onClick={() =>
                    openPad("收銀機名稱", "text", config.terminalName, (value) =>
                      setConfig((current) => ({ ...current, terminalName: value })),
                    )
                  }
                  value={config.terminalName}
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                <span className="text-xs text-slate-500">門店 ID</span>
                <input
                  readOnly
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-indigo-500"
                  onClick={() =>
                    openPad("門店 ID", "text", config.storeId, (value) =>
                      setConfig((current) => ({ ...current, storeId: value })),
                    )
                  }
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
                        readOnly
                        className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-indigo-500"
                        onClick={() =>
                          openPad("打印機名稱", "text", printer.name, (value) =>
                            updatePrinter(printer.id, { name: value }),
                          )
                        }
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
                        readOnly
                        className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-indigo-500"
                        onClick={() =>
                          openPad("IP 地址", "text", printer.ipAddress ?? "", (value) =>
                            updatePrinter(printer.id, { ipAddress: value }),
                          )
                        }
                        placeholder="192.168.1.110"
                        value={printer.ipAddress ?? ""}
                      />
                    </label>
                    <label className="grid gap-1 text-sm font-semibold text-slate-700">
                      <span className="text-xs text-slate-500">USB 標籤（USB）</span>
                      <input
                        readOnly
                        className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-indigo-500"
                        onClick={() =>
                          openPad("USB 標籤", "text", printer.usbLabel ?? "", (value) =>
                            updatePrinter(printer.id, { usbLabel: value }),
                          )
                        }
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
        ) : null}

        {activeTab === "tables" ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">樓層與桌台</h2>
                <p className="mt-1 text-sm text-slate-500">兩層結構：先樓層，再桌號。點餐頁會按這個結構顯示。</p>
              </div>
              <button
                className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white"
                onClick={() =>
                  setLocalSettings((current) => ({
                    ...current,
                    floors: [
                      ...current.floors,
                      { id: crypto.randomUUID(), name: `新樓層`, tables: [] },
                    ],
                  }))
                }
                type="button"
              >
                新增樓層
              </button>
            </div>

            <div className="mt-4 grid gap-3">
              {localSettings.floors.map((floor) => (
                <article key={floor.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-slate-900">{floor.name}</div>
                    <div className="flex gap-2">
                      <button
                        className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                        onClick={() =>
                          openPad("樓層名稱", "text", floor.name, (value) =>
                            setLocalSettings((current) => ({
                              ...current,
                              floors: current.floors.map((item) =>
                                item.id === floor.id ? { ...item, name: value || item.name } : item,
                              ),
                            })),
                          )
                        }
                        type="button"
                      >
                        修改樓層
                      </button>
                      <button
                        className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                        onClick={() =>
                          setLocalSettings((current) => ({
                            ...current,
                            floors: current.floors.map((item) =>
                              item.id === floor.id
                                ? {
                                    ...item,
                                    tables: [
                                      ...item.tables,
                                      {
                                        id: crypto.randomUUID(),
                                        name: `桌號${item.tables.length + 1}`,
                                        area: item.name,
                                        floorId: item.id,
                                      },
                                    ],
                                  }
                                : item,
                            ),
                          }))
                        }
                        type="button"
                      >
                        新增桌子
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
                    {floor.tables.map((table) => (
                      <button
                        key={table.id}
                        className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-left text-sm font-semibold text-slate-900 shadow-sm"
                        onClick={() =>
                          openPad("桌號", "text", table.name, (value) =>
                            setLocalSettings((current) => ({
                              ...current,
                              floors: current.floors.map((item) =>
                                item.id === floor.id
                                  ? {
                                      ...item,
                                      tables: item.tables.map((currentTable) =>
                                        currentTable.id === table.id
                                          ? { ...currentTable, name: value || currentTable.name, area: item.name }
                                          : currentTable,
                                      ),
                                    }
                                  : item,
                              ),
                            })),
                          )
                        }
                        type="button"
                      >
                        {table.name}
                      </button>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {activeTab === "payments" ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">支付方式</h2>
                <p className="mt-1 text-sm text-slate-500">自由文字方式，會記錄到 transaction。預設：現金、Mpay、中銀。</p>
              </div>
              <button
                className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white"
                onClick={() =>
                  setLocalSettings((current) => ({
                    ...current,
                    paymentMethods: [...current.paymentMethods, `新支付方式`],
                  }))
                }
                type="button"
              >
                新增支付方式
              </button>
            </div>

            <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {localSettings.paymentMethods.map((method, index) => (
                <button
                  key={`${method}-${index}`}
                  className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-left text-sm font-semibold text-slate-900"
                  onClick={() =>
                    openPad("支付方式", "text", method, (value) =>
                      setLocalSettings((current) => ({
                        ...current,
                        paymentMethods: current.paymentMethods.map((item, itemIndex) =>
                          itemIndex === index ? value || item : item,
                        ),
                      })),
                    )
                  }
                  type="button"
                >
                  {method}
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <InputPadModal
        mode={padMode}
        onChange={setPadValue}
        onClose={() => setPadOpen(false)}
        onConfirm={() => {
          padApply(padValue);
          setPadOpen(false);
        }}
        open={padOpen}
        title={padTitle}
        value={padValue}
      />
    </div>
  );
}
