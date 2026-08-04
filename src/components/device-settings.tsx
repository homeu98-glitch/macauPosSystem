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
    <div className="settings-page">
      <header className="hero-card">
        <div>
          <p className="eyebrow">Device Settings</p>
          <h1>打印與設備設定</h1>
          <p className="hero-copy">
            這裡只處理 POS 本機設備設定，例如 LAN/USB 打印機綁定。收銀規則仍然來自主系統，不在這邊改。
          </p>
        </div>
        <div className="hero-actions">
          <Link className="secondary-link" href="/">
            返回收銀台
          </Link>
        </div>
      </header>

      <section className="workspace single-column">
        <article className="panel">
          <div className="panel-head">
            <div>
              <h2>本機資料</h2>
              <p>{status}</p>
            </div>
          </div>

          <div className="form-grid">
            <label className="field">
              <span>設備 ID</span>
              <input
                onChange={(event) => setConfig((current) => ({ ...current, deviceId: event.target.value }))}
                value={config.deviceId}
              />
            </label>
            <label className="field">
              <span>收銀機名稱</span>
              <input
                onChange={(event) =>
                  setConfig((current) => ({ ...current, terminalName: event.target.value }))
                }
                value={config.terminalName}
              />
            </label>
            <label className="field">
              <span>門店 ID</span>
              <input
                onChange={(event) => setConfig((current) => ({ ...current, storeId: event.target.value }))}
                value={config.storeId}
              />
            </label>
          </div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <h2>打印機綁定</h2>
              <p>打印機設定在收銀台處理，但同步回後台保存，方便設備管理與追查。</p>
            </div>
          </div>

          <div className="printer-stack">
            {config.printers.map((printer) => (
              <section key={printer.id} className="printer-card">
                <div className="printer-header">
                  <div>
                    <strong>{printer.name}</strong>
                    <p>
                      {printer.group} · {printer.connectionType.toUpperCase()}
                    </p>
                  </div>
                  <label className="toggle">
                    <input
                      checked={printer.enabled}
                      onChange={(event) => updatePrinter(printer.id, { enabled: event.target.checked })}
                      type="checkbox"
                    />
                    <span>啟用</span>
                  </label>
                </div>

                <div className="form-grid">
                  <label className="field">
                    <span>打印機名稱</span>
                    <input
                      onChange={(event) => updatePrinter(printer.id, { name: event.target.value })}
                      value={printer.name}
                    />
                  </label>
                  <label className="field">
                    <span>連接方式</span>
                    <select
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
                  <label className="field">
                    <span>IP 地址</span>
                    <input
                      onChange={(event) => updatePrinter(printer.id, { ipAddress: event.target.value })}
                      placeholder="192.168.1.110"
                      value={printer.ipAddress ?? ""}
                    />
                  </label>
                  <label className="field">
                    <span>USB 標籤</span>
                    <input
                      onChange={(event) => updatePrinter(printer.id, { usbLabel: event.target.value })}
                      placeholder="USB-Receipt-01"
                      value={printer.usbLabel ?? ""}
                    />
                  </label>
                </div>

                <div className="printer-actions">
                  <button className="ghost-button" onClick={() => testPrint(printer)} type="button">
                    測試打印
                  </button>
                </div>
              </section>
            ))}
          </div>

          <div className="action-stack horizontal">
            <button className="secondary-button" onClick={saveLocal} type="button">
              只保存到本機
            </button>
            <button className="primary-button" onClick={syncConfig} type="button">
              保存並同步後台
            </button>
          </div>
        </article>
      </section>
    </div>
  );
}
