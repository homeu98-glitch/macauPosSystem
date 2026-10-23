// 一次性：驗證 /orders 左右分欄 + 卡片版真機渲染（純 UI 改動）
const { default: puppeteer } = await import(
  "file:///C:/Users/surface/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js"
);
import fs from "node:fs";

const BASE = "http://localhost:3017";
const OUT = "C:/dev/macauPos/macauPosSystem/docs/mockups/orders-left-right-split-2026-10-23/verify";
fs.mkdirSync(OUT, { recursive: true });

const MID = "66123456";
const now = new Date();
const iso = (m) => new Date(now.getTime() - m * 60000).toISOString();

const item = (menuItemId, name, price, quantity) => ({
  menuItemId, name, price, quantity, printerGroup: "kitchen",
});

const orders = [
  {
    id: "o-1", localOrderNo: "自取01", tableId: "counter", tableName: "自取",
    status: "settled", items: [item("m1", "人氣半筋半肉麵", 95, 1)],
    subtotal: 95, taxAmount: 0, serviceChargeAmount: 0, discountAmount: 0,
    total: 95, createdAt: iso(32), updatedAt: iso(30), paymentMethod: "mpay",
  },
  {
    id: "o-2", localOrderNo: "自取02", tableId: "counter", tableName: "自取",
    status: "sent_to_kitchen", fulfillmentStatus: "preparing",
    items: [item("m2", "豬扒包", 42, 1), item("m3", "凍咖啡", 24, 1)],
    subtotal: 66, taxAmount: 0, serviceChargeAmount: 0, discountAmount: 0,
    total: 66, createdAt: iso(34), updatedAt: iso(33), paymentMethod: "mpay",
  },
  {
    id: "o-3", localOrderNo: "L0031", tableId: "t-a03", tableName: "A3 枱",
    status: "sent_to_kitchen", fulfillmentStatus: "preparing", partySize: 2,
    items: [item("m4", "葡國雞飯", 88, 2), item("m5", "凍檸茶", 10, 2)],
    subtotal: 196, taxAmount: 0, serviceChargeAmount: 0, discountAmount: 0,
    total: 196, createdAt: iso(43), updatedAt: iso(42),
  },
  {
    id: "o-4", localOrderNo: "L0032", tableId: "t-b01", tableName: "B1 枱",
    status: "paid", fulfillmentStatus: "ready", partySize: 1,
    items: [item("m6", "免治牛肉飯", 68, 1), item("m7", "例湯", 10, 1)],
    subtotal: 78, taxAmount: 0, serviceChargeAmount: 0, discountAmount: 0,
    total: 78, createdAt: iso(55), updatedAt: iso(50), paymentMethod: "cash",
  },
  {
    id: "o-5", localOrderNo: "L0030", tableId: "t-a01", tableName: "A1 枱",
    status: "settled", partySize: 3,
    items: [item("m8", "非洲雞", 128, 1), item("m9", "白飯", 15, 2)],
    subtotal: 158, taxAmount: 0, serviceChargeAmount: 0, discountAmount: 0,
    total: 158, createdAt: iso(73), updatedAt: iso(70), paymentMethod: "cash",
  },
  {
    id: "o-6", localOrderNo: "L0029", tableId: "t-c02", tableName: "C2 枱",
    status: "reopened", partySize: 2,
    items: [item("m10", "馬介休球", 78, 2), item("m11", "凍檸水", 10, 1)],
    subtotal: 88, taxAmount: 0, serviceChargeAmount: 0, discountAmount: 0,
    total: 88, createdAt: iso(87), updatedAt: iso(85),
  },
];

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: ["--font-render-hinting=none"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1180, height: 820, deviceScaleFactor: 1 });

// 先入一次，令 localStorage 有 origin，再寫種子資料
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate(
  ({ MID, orders }) => {
    localStorage.clear();
    // docs/162 冷啟守衛：sessionStorage 有解鎖標記先唔會被踢去 /login
    sessionStorage.setItem("macau-pos/terminal-unlocked", new Date().toISOString());
    localStorage.setItem(
      "macau-pos/auth-session",
      JSON.stringify({
        account: MID, name: "表嫂美食", role: "manager", merchantId: MID,
        ledgerAccessToken: "demo", ledgerRefreshToken: "demo",
        permissions: {}, loggedInAt: new Date().toISOString(),
      }),
    );
    localStorage.setItem(
      `macau-pos/stores/${MID}/bootstrap`,
      JSON.stringify({
        storeId: MID, storeName: "表嫂美食", currency: "MOP",
        tables: [
          { id: "t-a01", name: "A1", area: "大堂", capacity: 4, status: "occupied" },
          { id: "t-a03", name: "A3", area: "大堂", capacity: 4, status: "occupied" },
          { id: "t-b01", name: "B1", area: "大堂", capacity: 2, status: "occupied" },
          { id: "t-c02", name: "C2", area: "大堂", capacity: 4, status: "occupied" },
        ],
      }),
    );
    localStorage.setItem(`macau-pos/stores/${MID}/orders`, JSON.stringify(orders));
  },
  { MID, orders },
);

await page.goto(`${BASE}/orders`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ path: `${OUT}/orders-1180.png` });

// 窄一點（iPad 直向闊度）睇下會唔會爆版
await page.setViewport({ width: 834, height: 1112, deviceScaleFactor: 1 });
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: `${OUT}/orders-834.png` });

// iPad 9.7" 橫向（1024）：左右分欄嘅最窄情況
await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1 });
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: `${OUT}/orders-1024.png` });

await browser.close();
console.log("done");
