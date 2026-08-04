"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { defaultDeviceConfig, defaultPosLocalSettings, mockBootstrap } from "@/lib/mock-data";
import {
  loadBootstrapCache,
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
  const cachedBootstrap = loadBootstrapCache() ?? mockBootstrap;
  const [config, setConfig] = useState<DeviceConfig>(cachedConfig ?? defaultDeviceConfig);
  const [localSettings, setLocalSettings] = useState<PosLocalSettings>(cachedLocalSettings ?? defaultPosLocalSettings);
  const [status, setStatus] = useState(cachedConfig ? "已載入本機設定。" : "尚未同步設定。");
  const [activeTab, setActiveTab] = useState<"device" | "menu-print" | "tables" | "payments" | "online-orders">("device");

  useEffect(() => {
    if (!cachedConfig) {
      saveDeviceConfig(defaultDeviceConfig);
    }
    if (!cachedLocalSettings) {
      savePosLocalSettings(defaultPosLocalSettings);
    }
  }, [cachedConfig, cachedLocalSettings]);

  useEffect(() => {
    async function loadOnlineOrderSettings() {
      try {
        const response = await fetch("/api/online-order-settings");
        const payload = (await response.json()) as { autoAccept?: boolean };
        setLocalSettings((current) => ({
          ...current,
          onlineOrderSettings: {
            autoAccept: payload.autoAccept ?? current.onlineOrderSettings.autoAccept,
          },
        }));
      } catch {
        // 保留本機設定
      }
    }

    void loadOnlineOrderSettings();
  }, []);

  useEffect(() => {
    async function loadRemoteConfig() {
      try {
        const response = await fetch("/api/pos/device-config");
        const payload = (await response.json()) as {
          deviceConfig?: DeviceConfig | null;
          localSettings?: PosLocalSettings | null;
        };
        if (payload.deviceConfig) {
          setConfig(payload.deviceConfig);
          saveDeviceConfig(payload.deviceConfig);
        }
        if (payload.localSettings) {
          setLocalSettings(payload.localSettings);
          savePosLocalSettings(payload.localSettings);
        }
      } catch {
        // 保留本機設定
      }
    }

    void loadRemoteConfig();
  }, []);

  const printerGroupOptions = useMemo(
    () =>
      config.printers
        .filter((printer) => printer.enabled)
        .map((printer) => ({
          value: printer.group,
          label: `${printer.name} (${printer.group})`,
        })),
    [config.printers],
  );

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
        menuPrinterOverrides: localSettings.menuPrinterOverrides,
        onlineOrderSettings: localSettings.onlineOrderSettings,
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
        body: JSON.stringify({
          ...updatedConfig,
          localSettings,
        }),
      });
      await fetch("/api/online-order-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(localSettings.onlineOrderSettings),
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
      <AppSidebar />
      <div className="sticky top-0 z-20 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-4 py-3 lg:pl-[88px]">
          <div>
            <div className="text-lg font-semibold text-slate-900">設置</div>
            <div className="mt-1 text-sm text-slate-500">
              打印機、菜品打印、樓層桌台、支付方式、線上訂單都集中在這裡。
            </div>
          </div>
          <Link className="rounded-full bg-indigo-600 px-3 py-2 text-sm font-semibold text-white" href="/">
            返回收銀台
          </Link>
        </div>
      </div>

      <div className="mx-auto max-w-[1600px] px-4 py-3 lg:pl-[88px]">
        <div className="mb-3 flex flex-wrap gap-2">
          {[
            ["device", "打印機"],
            ["menu-print", "菜品打印設置"],
            ["tables", "樓層與桌台"],
            ["payments", "支付方式"],
            ["online-orders", "線上訂單"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                activeTab === key ? "bg-orange-500 text-white" : "bg-white text-slate-700 ring-1 ring-slate-200"
              }`}
              onClick={() => setActiveTab(key as typeof activeTab)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mb-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          {status}
        </div>

        {activeTab === "device" ? (
          <div className="grid gap-3 lg:grid-cols-[380px_minmax(0,1fr)]">
            <section className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="text-base font-semibold text-slate-900">本機資料</div>
              <div className="mt-4 grid gap-3">
                <label className="grid gap-1 text-sm font-semibold text-slate-700">
                  <span className="text-xs text-slate-500">設備 ID</span>
                  <input
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    onChange={(event) => setConfig((current) => ({ ...current, deviceId: event.target.value }))}
                    value={config.deviceId}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-700">
                  <span className="text-xs text-slate-500">收銀機名稱</span>
                  <input
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    onChange={(event) => setConfig((current) => ({ ...current, terminalName: event.target.value }))}
                    value={config.terminalName}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-700">
                  <span className="text-xs text-slate-500">門店 ID</span>
                  <input
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    onChange={(event) => setConfig((current) => ({ ...current, storeId: event.target.value }))}
                    value={config.storeId}
                  />
                </label>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                  onClick={saveLocal}
                  type="button"
                >
                  只保存到本機
                </button>
                <button
                  className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white"
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
                  <div className="text-base font-semibold text-slate-900">打印機綁定</div>
                  <div className="mt-1 text-sm text-slate-500">
                    每台打印機可分配給廚房、飲品吧或收據。列表可向下滾動，不會再被截斷。
                  </div>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                  {config.printers.length} printers
                </span>
              </div>

              <div className="mt-4 max-h-[68vh] overflow-auto pr-1">
                <div className="grid gap-3">
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

                      <div className="mt-4 grid gap-3 md:grid-cols-2">
                        <label className="grid gap-1 text-sm font-semibold text-slate-700">
                          <span className="text-xs text-slate-500">打印機名稱</span>
                          <input
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            onChange={(event) => updatePrinter(printer.id, { name: event.target.value })}
                            value={printer.name}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold text-slate-700">
                          <span className="text-xs text-slate-500">打印分組</span>
                          <select
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            onChange={(event) =>
                              updatePrinter(printer.id, { group: event.target.value as DevicePrinterConfig["group"] })
                            }
                            value={printer.group}
                          >
                            <option value="kitchen">廚房</option>
                            <option value="drinks">水吧</option>
                            <option value="receipt">收據</option>
                          </select>
                        </label>
                        <label className="grid gap-1 text-sm font-semibold text-slate-700">
                          <span className="text-xs text-slate-500">連接方式</span>
                          <select
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
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
                          <span className="text-xs text-slate-500">IP 地址</span>
                          <input
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            onChange={(event) => updatePrinter(printer.id, { ipAddress: event.target.value })}
                            value={printer.ipAddress ?? ""}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold text-slate-700 md:col-span-2">
                          <span className="text-xs text-slate-500">USB 標籤</span>
                          <input
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            onChange={(event) => updatePrinter(printer.id, { usbLabel: event.target.value })}
                            value={printer.usbLabel ?? ""}
                          />
                        </label>
                      </div>

                      <div className="mt-4 flex justify-end">
                        <button
                          className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                          onClick={() => testPrint(printer)}
                          type="button"
                        >
                          測試打印
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            </section>
          </div>
        ) : null}

        {activeTab === "menu-print" ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-900">菜品打印設置</div>
                <div className="mt-1 text-sm text-slate-500">
                  最佳方案是兩層：菜品先分配到打印分組，再由打印機綁定分組。這樣換機時不用逐個菜改。
                </div>
              </div>
            </div>

            <div className="mt-4 overflow-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs font-semibold text-slate-500">
                    <th className="border-b border-slate-200 py-2 pr-3">菜品</th>
                    <th className="border-b border-slate-200 py-2 pr-3">分類</th>
                    <th className="border-b border-slate-200 py-2 pr-3">當前分組</th>
                    <th className="border-b border-slate-200 py-2">會打印到</th>
                  </tr>
                </thead>
                <tbody>
                  {cachedBootstrap.menuItems.map((item) => {
                    const group = localSettings.menuPrinterOverrides[item.id] ?? item.printerGroup;
                    return (
                      <tr key={item.id}>
                        <td className="border-b border-slate-100 py-2 pr-3 font-semibold text-slate-900">{item.name}</td>
                        <td className="border-b border-slate-100 py-2 pr-3 text-slate-600">{item.categoryId}</td>
                        <td className="border-b border-slate-100 py-2 pr-3">
                          <select
                            className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            onChange={(event) =>
                              setLocalSettings((current) => ({
                                ...current,
                                menuPrinterOverrides: {
                                  ...current.menuPrinterOverrides,
                                  [item.id]: event.target.value as DevicePrinterConfig["group"],
                                },
                              }))
                            }
                            value={group}
                          >
                            <option value="kitchen">廚房</option>
                            <option value="drinks">水吧</option>
                            <option value="receipt">收據</option>
                          </select>
                        </td>
                        <td className="border-b border-slate-100 py-2 text-slate-600">
                          {printerGroupOptions.filter((printer) => printer.value === group).map((printer) => printer.label).join("、") || "未綁定啟用打印機"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {activeTab === "tables" ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-900">樓層與桌台</div>
                <div className="mt-1 text-sm text-slate-500">兩層結構：先樓層，再桌號。</div>
              </div>
              <button
                className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white"
                onClick={() =>
                  setLocalSettings((current) => ({
                    ...current,
                    floors: [...current.floors, { id: crypto.randomUUID(), name: "新樓層", tables: [] }],
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
                    <input
                      className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
                      onChange={(event) =>
                        setLocalSettings((current) => ({
                          ...current,
                          floors: current.floors.map((item) =>
                            item.id === floor.id ? { ...item, name: event.target.value } : item,
                          ),
                        }))
                      }
                      value={floor.name}
                    />
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
                                    { id: crypto.randomUUID(), name: `桌號${item.tables.length + 1}`, area: item.name, floorId: item.id },
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
                  <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
                    {floor.tables.map((table) => (
                      <input
                        key={table.id}
                        className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-900"
                        onChange={(event) =>
                          setLocalSettings((current) => ({
                            ...current,
                            floors: current.floors.map((item) =>
                              item.id === floor.id
                                ? {
                                    ...item,
                                    tables: item.tables.map((currentTable) =>
                                      currentTable.id === table.id
                                        ? { ...currentTable, name: event.target.value, area: item.name }
                                        : currentTable,
                                    ),
                                  }
                                : item,
                            ),
                          }))
                        }
                        value={table.name}
                      />
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
                <div className="text-base font-semibold text-slate-900">支付方式</div>
                <div className="mt-1 text-sm text-slate-500">自由文字方式，會記錄到交易裡。預設：現金、Mpay、中銀。</div>
              </div>
              <button
                className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white"
                onClick={() =>
                  setLocalSettings((current) => ({
                    ...current,
                    paymentMethods: [...current.paymentMethods, "新支付方式"],
                  }))
                }
                type="button"
              >
                新增支付方式
              </button>
            </div>
            <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {localSettings.paymentMethods.map((method, index) => (
                <input
                  key={`${method}-${index}`}
                  className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-900"
                  onChange={(event) =>
                    setLocalSettings((current) => ({
                      ...current,
                      paymentMethods: current.paymentMethods.map((item, itemIndex) =>
                        itemIndex === index ? event.target.value : item,
                      ),
                    }))
                  }
                  value={method}
                />
              ))}
            </div>
          </section>
        ) : null}

        {activeTab === "online-orders" ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-base font-semibold text-slate-900">線上訂單</div>
            <div className="mt-1 text-sm text-slate-500">自動接單設定從 API 下發，但商家可以在這裡打開或關閉。</div>
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <label className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-900">自動接單</div>
                  <div className="mt-1 text-xs text-slate-500">
                    打開後，所有線上訂單都會自動變成已接單；堂食單仍然需要商家手動安排桌子。
                  </div>
                </div>
                <input
                  checked={localSettings.onlineOrderSettings.autoAccept}
                  onChange={(event) =>
                    setLocalSettings((current) => ({
                      ...current,
                      onlineOrderSettings: {
                        ...current.onlineOrderSettings,
                        autoAccept: event.target.checked,
                      },
                    }))
                  }
                  type="checkbox"
                />
              </label>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
