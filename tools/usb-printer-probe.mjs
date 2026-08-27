#!/usr/bin/env node
// tools/usb-printer-probe.mjs
//
// P1 · USB 描述符探測（決策用）
// 目的：插咗目標機（例：商頌 POS-80）之後跑一次，決定佢係 A / B / C 邊種 USB 姿態，
//       從而決定我哋「接上就用」行邊條通道：
//         A → USB Printer Class(07h) → OS inbox driver → spooler RAW 直通（最 universal，真 driverless）
//         B → vendor bulk + WinUSB   → libusb / node-usb bulkTransfer（仍 driverless）
//         C → vendor COM (CH34x/FTDI/CP210x) → 要裝一次 serial driver 先出 COMx（唔算 driverless）
//
// 跑法：
//   1) 零依賴（Windows 推薦先試，唔使 npm install）：
//        node tools/usb-printer-probe.mjs
//        → 用 PowerShell Get-PnpDevice 睇 Windows 點 load 部機（最準嘅 A/C 信號）
//   2) 詳細 descriptor（要裝 libusb）：
//        npm i usb && node tools/usb-printer-probe.mjs --libusb
//        → 列舉 VID/PID + 每個 interface 嘅 bInterfaceClass（07h=Printer / FFh=vendor bulk / 02h=CDC）
//
// 支援：Windows（兩種模式）/ macOS / Linux（自動跳過 PowerShell，行 libusb）。

import { execSync } from "node:child_process";
import os from "node:os";

// ---- 已知廠牌 VID（hex，小寫）----
const VENDOR_NAMES = {
  "1a86": "QinHeng (CH34x 序列)",
  "0403": "FTDI",
  "10c4": "Silicon Labs (CP210x)",
  "067b": "Prolific (PL2303)",
  "04b8": "Epson",
  "0519": "Star",
  "04cb": "Citizen",
  "0b27": "Bixolon",
  "0708": "Seiko",
  "0483": "STMicro (常見 vendor)",
  "1fc9": "NXP",
};

// 呢啲 VID 一出基本就係 C 姿態（要裝 serial driver）
const SERIAL_VIDS = new Set(["1a86", "0403", "10c4", "067b"]);

function classToName(c) {
  return (
    {
      0x00: "Unknown",
      0x01: "Audio",
      0x02: "CDC (虛擬 COM)",
      0x03: "HID",
      0x07: "Printer ★A (USB Printer Class)",
      0x08: "Mass Storage",
      0xff: "Vendor-specific ★B (bulk 候選)",
    }[c] ?? `0x${c.toString(16).padStart(2, "0")}`
  );
}

function hl(hex) {
  return hex.toLowerCase().padStart(4, "0");
}

// ============ 1) OS 層探測（Windows PowerShell）============
function probeWindowsPnp() {
  if (os.platform() !== "win32") return null;
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-PnpDevice -PresentOnly | Where-Object { $_.Class -in @(\'USB\',\'Printer\',\'Ports\',\'Dot4\',\'PrintQueue\') } | Select-Object Status,Class,FriendlyName,InstanceId | Format-List"',
      { encoding: "utf8", timeout: 30000 }
    );
    return out;
  } catch (e) {
    return `（PowerShell 探測失敗：${e.message}）`;
  }
}

// ============ 2) libusb 層探測（descriptor）============
async function probeLibusb() {
  let mod;
  try {
    mod = await import("usb");
  } catch {
    return null; // 未裝 node-usb
  }
  const usb = mod.default ?? mod;
  const results = [];
  for (const dev of usb.getDeviceList()) {
    let desc;
    try {
      desc = dev.deviceDescriptor;
    } catch {
      continue;
    }
    const vidHex = "0x" + desc.idVendor.toString(16).padStart(4, "0");
    const pidHex = "0x" + desc.idProduct.toString(16).padStart(4, "0");
    let manufacturer = "";
    let product = "";
    const ifaces = [];
    let opened = false;
    try {
      dev.open();
      opened = true;
      // 讀 config descriptor（Windows 無 driver 會掟）
      const cfg = dev.configDescriptor;
      for (const iface of cfg.interfaces) {
        for (const alt of iface) {
          const eps = (alt.bEndpointDescriptors || []).map((e) => ({
            dir: e.bEndpointAddress & 0x80 ? "OUT" : "IN",
            type:
              (e.bmAttributes & 0x03) === 2
                ? "BULK"
                : (e.bmAttributes & 0x03) === 3
                ? "INT"
                : "OTHER",
          }));
          ifaces.push({
            cls: alt.bInterfaceClass,
            sub: alt.bInterfaceSubClass,
            eps,
          });
        }
      }
      // 讀 string（node-usb v2 係 async）
      try {
        manufacturer = await dev.getStringDescriptor(desc.iManufacturer);
      } catch {}
      try {
        product = await dev.getStringDescriptor(desc.iProduct);
      } catch {}
    } catch {
      // 讀唔到 config：Windows 上多數係未綁 WinUSB / 無 driver
    } finally {
      if (opened) {
        try {
          dev.close();
        } catch {}
      }
    }
    results.push({ vidHex, pidHex, manufacturer, product, ifaces });
  }
  return results;
}

// ============ 分類邏輯 ============
function classifyFromLibusb(results) {
  const hits = [];
  for (const r of results) {
    const vid = hl(r.vidHex.replace(/^0x/, ""));
    const name = VENDOR_NAMES[vid] || "未知廠牌";
    const classes = [...new Set(r.ifaces.map((i) => i.cls))];
    const hasPrinter = classes.includes(0x07);
    const hasVendor = classes.includes(0xff);
    const hasCdc = classes.includes(0x02);
    const hasBulk = r.ifaces.some((i) =>
      i.eps.some((e) => e.type === "BULK")
    );
    let posture = "?";
    if (hasPrinter) posture = "A";
    else if (hasVendor && hasBulk) posture = "B";
    else if (SERIAL_VIDS.has(vid)) posture = "C";
    else if (hasCdc) posture = "B(CDC)";
    hits.push({
      vidHex: r.vidHex,
      pidHex: r.pidHex,
      name,
      posture,
      classes: classes.map(classToName),
      manufacturer: r.manufacturer,
      product: r.product,
    });
  }
  return hits;
}

// ============ main ============
async function main() {
  const forceLibusb = process.argv.includes("--libusb");
  console.log("════════════════════════════════════════════════════════");
  console.log("  USB 打印機姿態探測 (A/B/C) — P1 決策工具");
  console.log("  platform:", os.platform(), os.release());
  console.log("════════════════════════════════════════════════════════\n");

  // --- Windows PnP（零依賴，最準）---
  if (!forceLibusb) {
    const pnp = probeWindowsPnp();
    if (pnp !== null) {
      console.log("【Windows 裝置檢視（Get-PnpDevice）】");
      console.log(pnp);
      console.log("👉 睇 FriendlyName：");
      console.log('   - 見「USB Printing Support」/「USB 打印機」 → A 姿態（driverless）');
      console.log('   - 見「USB-SERIAL CH340」/「(COMx)」        → C 姿態（要裝 CH34x）');
      console.log("");
    }
  }

  // --- libusb descriptor ---
  const lib = await probeLibusb();
  if (lib === null) {
    if (forceLibusb) {
      console.log("❌ 未裝 node-usb。請先：npm i usb");
    } else if (os.platform() === "win32") {
      console.log(
        "（libusb 未裝 → 跳過 descriptor 模式；上面 Windows 檢視已足夠判斷 A/C）"
      );
      console.log("   要睇 interface class 明細請：npm i usb && node tools/usb-printer-probe.mjs --libusb");
    } else {
      console.log("❌ 未裝 node-usb。請先：npm i usb");
    }
    console.log("\n════════════════════════════════════════════════════════");
    return;
  }

  const hits = classifyFromLibusb(lib);
  console.log("【libusb 枚舉（VID/PID + interface class）】");
  if (hits.length === 0) {
    console.log("   搵唔到任何 USB 裝置（部機可能未插 / 未開電）");
  }
  for (const h of hits) {
    console.log(`   ${h.vidHex}:${h.pidHex}  [${h.posture}]  ${h.name}`);
    if (h.manufacturer || h.product)
      console.log(`       str: ${h.manufacturer || "?"} / ${h.product || "?"}`);
    console.log(
      "       ifaces: " + (h.classes.join(", ") || "(讀唔到 — Windows 多數未綁 WinUSB)")
    );
  }

  // --- 總結 ---
  const postureSet = new Set(hits.map((h) => h.posture));
  console.log("\n──────── 總結 ────────");
  if (postureSet.has("A")) {
    console.log("✅ 偵測到 USB Printer Class → 行 A 通道（spooler RAW 直通，最 universal，真 driverless）");
  } else if (postureSet.has("B") || postureSet.has("B(CDC)")) {
    console.log("✅ 偵測到 vendor bulk / CDC → 行 B 通道（libusb + WinUSB，仍 driverless；要有 MS OS Descriptor 或 ship WinUSB INF）");
  } else if (postureSet.has("C")) {
    console.log("⚠️  偵測到 serial VID (CH34x/FTDI/CP210x) → 行 C 通道（要裝一次 serial driver 先出 COMx，唔算純 driverless）");
  } else {
    console.log("❓ 未確定姿態：請睇上面 Windows 檢視嘅 FriendlyName，或 --libusb 模式嘅 interface class");
  }
  console.log("════════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error("probe error:", e);
  process.exit(1);
});
