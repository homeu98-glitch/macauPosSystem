// ⚠️ 副檔名 `.ts` 係刻意嘅：`npm test` = `node --test`，**唔做** extension resolution
// （唔認tsconfig 嘅 moduleResolution）。跟 `kds-board.test.ts` / `order-event-time.ts` 慣例。
import { ZH_HANT_DICT } from "./i18n-dict-zh.ts";

/**
 * 英文字典（第 1 層：UI 顯示文案）。
 *
 * ## ⚠️ 英文比中文長 —— 版面預算（真實量度）
 *
 * 中文「打印機」3 字 ≈ 3em；英文 `"Printer"` 7 字元 ≈ 3.5em（Inter latin 子集）。
 * 但複合詞差距更大，且**英文字母寬度唔平均**，必須逐個睇：
 *
 * | 中文 | 字數 | 英文建議 | 字元 | 比例 |
 * |---|---|---|---|---|
 * | 打印機 | 3 | Printer | 7 | ~2.3× |
 * | 菜品打印設置 | 6 | Dish print settings | 20 | ~3.3× |
 * | 樓層與桌台 | 5 | Floors & tables | 16 | ~3.2× |
 * | 線上接單 | 4 | Online orders | 13 | ~3.3× |
 * | 掃碼點餐 | 4 | QR self-order | 14 | ~3.5× |
 * | 選擇工作台 | 5 | Select workstation | 18 | ~3.6× |
 *
 * ⚠️ 因此**唔好為咗塞英文而譯得過短**（例如 `"Receipt"` 而唔係
 * `"Sales receipt"`）—— 短譯會令 UI 語意含糊。真正嘅處理係
 * 版面層配合（見 memory「英文較長溢出處理」）。
 *
 * ⚠️ 截圖用字：`Printer` / `Dish print settings` 保持首字母大寫；
 * 但**同一組內唔好混用大小寫風格**。
 */
export const EN_DICT: Record<string, string> = {
  // ─── 設置頁 · 主 tab ───
  打印機: "Printer",
  菜品打印設置: "Dish print settings",
  菜單: "Menu",
  樓層與桌台: "Floors & tables",
  支付方式: "Payment methods",
  線上接單: "Online orders",
  備註: "Notes",
  折扣: "Discounts",
  掃碼點餐: "QR self-order",

  // ─── 設置頁 · 語言切換 ───
  介面語言: "Interface language",
  語言: "Language",
  "介面語言（只影響呢部機）": "Interface language (this device only)",
  "切換語言會即時生效，唔使重新載入。紙單同收據維持繁體中文，唔受呢個設定影響。":
    "Takes effect immediately, no reload needed. Paper receipts and printed slips stay in Traditional Chinese and are not affected.",

  // ─── 設置頁 · device tab · 打印機綁定 ───
  打印機綁定: "Printer binding",
  "支援自定義分區、唯一收據打印機，以及綁定分區的標籤機。":
    "Supports custom zones, a single receipt printer, and label printers bound to a zone.",
  "同步中…": "Syncing…",
  保存: "Save",
  打印機列表: "Printer list",
  "分區可自由新增，例如：廚房、水吧、甜品、燒味。":
    "Add zones freely, for example: Kitchen, Drinks, Desserts, Roast meats.",
  "已刪除打印分區。": "Print zone deleted.",
  "新增分區，例如：甜品": "New zone, e.g. Desserts",
  "已新增打印分區。": "Print zone added.",
  新增分區: "Add zone",
  交班單打印機: "Shift report printer",
  "指定結數交班明細由邊台打印機出紙；唔揀 = 跟隨收據打印機。已停用嘅打印機唔會出紙。":
    "Choose which printer prints the end-of-shift breakdown. Leave empty to follow the receipt printer. Disabled printers will not print.",
  "跟隨收據打印機（預設）": "Follow receipt printer (default)",
  "（已停用）": " (disabled)",
  平台打印機: "Platform printer",
  "澳覓 / MFOOD 平台單嘅廚房單由邊個打印分區出紙；唔揀 = 跟隨廚房分區（同堂食單一樣去廚房機）。":
    "Which print zone prints kitchen tickets for delivery-platform orders. Leave empty to follow the kitchen zone.",
  "跟隨廚房分區（預設）": "Follow kitchen zone (default)",
  "（分區已刪除）": " (zone deleted)",
  "想多台機同時出平台單 → 把嗰幾台機嘅「打印分區」都設成同一個分區就得。":
    "To print platform orders on several machines, set each machine's print zone to the same zone.",
  "注意：分區「{zone}」冇啟用嘅分區打印機 → 平台單會收唔到紙。請去下面把該台機嘅「打印分區」設成佢，或者改用其他分區。":
    "Warning: zone “{zone}” has no enabled zone printer, so platform orders will not print. Set that machine's print zone below, or pick another zone.",

  // ─── 通用單字（AutoAcceptPill 等全站共用元件）───
  開: "On",
  關: "Off",
  自動接單: "Auto-accept",
  自動接自助單: "Auto-accept kiosk",
  即時模式: "Live",

  // ─── 側欄 · 同步健康徽章（app-sidebar.tsx）───
  同步受阻: "Sync blocked",
  "{n} 張待傳": "{n} pending",
  離線待傳: "Offline, pending",
  在線: "Online",
  離線: "Offline",
  "有 {n} 張訂單連續多次補推都對唔上雲端，撳一下即刻再試。":
    "{n} orders could not be confirmed in the cloud after several retries. Tap to retry now.",
  "待上傳：{a} 張終態訂單未確認、{b} 條事件排隊、{c} 條退避重試。撳一下即刻再試。":
    "Pending upload: {a} final orders unconfirmed, {b} events queued, {c} retries backing off. Tap to retry now.",
  "而家離線，恢復網絡後會自動補傳（資料已保留喺本機）。":
    "Currently offline. Data is kept on this machine and will upload automatically once the network returns.",
  "網絡已連接；所有已結帳／已取消訂單都已確認上雲。":
    "Network connected. All settled or cancelled orders are confirmed in the cloud.",
  "網絡已斷開；目前冇待上傳資料。": "Network disconnected. Nothing is waiting to upload.",
  "重試中…": "Retrying…",
  總部: "HQ",
  收銀: "Cashier",
  已暫停: "Paused",
  以此身份登出: "Sign out of this role",
  "店內暫停營業中（掃碼點餐、自助點餐機落唔到單）—— 撳一下恢復營業":
    "In-store ordering is paused (QR ordering and the self-order kiosk cannot take orders). Tap to resume.",
  "營業中 —— 撳一下可暫停店內營業": "Open. Tap to pause in-store ordering.",
  "未讀到營業狀態（可能係讀取失敗），請重新載入頁面":
    "Could not read the open/closed state (it may have failed to load). Reload the page.",

  // ─── 設置頁 · 打印開關設置 ───
  打印開關設置: "Automatic print switches",
  "關閉後對應類型嘅自動打印唔會出單（例如唔想出退菜單就熄「退菜／退桌單」）。手動掣（打印廚房單、打印收據、重打整單、重打交班單等）永遠不受呢啲開關影響。":
    "When off, that type will not print automatically (e.g. turn off Void tickets if you do not want them). Manual buttons (print kitchen ticket, print receipt, reprint order, reprint shift report) are never affected.",
  自動打印: "Auto",
  已關閉: "Off",
  "{label}打印": "{label} printing",

  // ─── 打印內容開關行（PRINT_CONTENT_TOGGLE_ROWS）───
  廚房單: "Kitchen ticket",
  飲品標籤單: "Drink label",
  線上訂單: "Online orders",
  平台廚房單: "Platform kitchen ticket",
  結帳收據: "Sales receipt",
  "退菜／退桌單": "Void / cancel ticket",
  返結單: "Reopen ticket",
  自助機小票: "Kiosk receipt",
  交班單: "Shift report",
  "收銀落單／加單、線上單接單、自助單補建。對應分區打印機（zone role）。":
    "Register orders and add-ons, online order acceptance, kiosk backfill. Uses zone printers.",
  "收銀落單／加單、線上單接單。對應標籤打印機（label role，62mm 標籤卷）。":
    "Register orders and add-ons, online order acceptance. Uses label printers (62mm label rolls).",
  "線上（Ledger／會員通）訂單接單時，喺廚房出單。若 Sunmi 系統本身已經會印線上單，可熄呢個掣避免重複出紙。唔影響本地堂食／掃碼單。":
    "Prints a kitchen ticket when an online (Ledger) order is accepted. If your Sunmi system already prints online orders, turn this off to avoid duplicates. Local dine-in and QR orders are unaffected.",
  "外賣平台單（澳覓 / MFOOD）入機時，喺廚房出單（去邊個分區由「打印機 → 平台打印機」決定）。同「廚房單」係乘積關係：兩者都要開先出紙。唔影響會員通（Ledger）線上單。":
    "Prints a kitchen ticket when a delivery-platform order (Aomi / MFOOD) arrives. The zone is set under Printer → Platform printer. Both this and Kitchen ticket must be on. Ledger online orders are unaffected.",
  "收銀結帳、免單、線上單完成+已付、到店付款。對應收據打印機。":
    "Register checkout, free orders, online orders completed and paid, pay at counter. Uses the receipt printer.",
  "收銀退單項／全單退、退桌、線上單取消。影響分區 + 標籤打印機。":
    "Voiding items or a whole order at the register, table cancellation, online order cancellation. Affects zone and label printers.",
  "已結帳單退回可編輯狀態時出嘅修正單（含原因 + 操作人）。":
    "Correction ticket printed when a settled order is reopened for editing (includes reason and operator).",
  "自助點餐機（kiosk）落單後即時印嘅顧客小票（本機排隊、唔上雲）。":
    "Guest receipt printed immediately when an order is placed on the self-order kiosk (queued locally, not uploaded).",
  "收工時出嘅交班明細單（交班單打印機或收據打印機 fallback）。":
    "End-of-shift breakdown printed at closing (shift report printer, falling back to the receipt printer).",

  // ─── 設置頁 · Companion 打印機（printer-companion-panel）───
  "桌面 Companion 代理": "Desktop Companion agent",
  "已連線（v{version}）": "Connected (v{version})",
  "未連線（代理未啟動）": "Not connected (agent not running)",
  "偵測中…": "Detecting…",
  "測試中…": "Testing…",
  測試連線: "Test connection",
  "代理地址（固定，無須設定）": "Agent address (fixed, nothing to configure)",
  "配對 Token（留空即可）": "Pairing token (leave empty)",
  "（留空）": "(empty)",
  "代理地址固定為 loopback（127.0.0.1:9311），開 App 自動配對；商家無須輸入 IP 或 Token。":
    "The agent address is fixed to loopback (127.0.0.1:9311) and pairs automatically when the app opens. Merchants do not need to enter an IP or token.",
  "加入打印機（自動偵測）": "Add a printer (auto-detect)",
  "按下面掃描，Companion 會列出區網 / USB 打印機，唔使手填 VID/PID。":
    "Scan below and Companion will list LAN and USB printers. No need to type VID/PID.",
  "掃描中…": "Scanning…",
  "+ 區網 / LAN 打印機": "+ LAN printer",
  "枚舉中…": "Enumerating…",
  "+ USB 打印機": "+ USB printer",
  "探索中…": "Discovering…",
  "+ 藍牙打印機": "+ Bluetooth printer",
  "auto search 失敗？用手動 fallback：": "Auto search failed? Use the manual fallback:",
  "手動+ 區網 / LAN 打印機": "Manual + LAN printer",
  "手動+ USB 打印機": "Manual + USB printer",
  "手動+ 藍牙打印機": "Manual + Bluetooth printer",
  "手動加入 LAN 打印機（輸入 IP）": "Add a LAN printer manually (enter IP)",
  "IP 位址": "IP address",
  連接埠: "Port",
  "以此 IP 加入": "Add with this IP",
  取消: "Cancel",
  "手動選擇已連接嘅 USB 打印機": "Manually pick a connected USB printer",
  "未枚舉到 USB 打印機（請確認已插好並安裝驅動；未知型號可用 VID/PID 手填）。":
    "No USB printer found. Check it is plugged in and the driver is installed; for unknown models enter VID/PID manually.",
  "— 選擇打印機 —": "— Select a printer —",
  "手動選擇藍牙（SPP）打印機": "Manually pick a Bluetooth (SPP) printer",
  "未列舉到藍牙序列埠（請先於系統配對，Windows 會出虛擬 COM port；Companion 需裝 serialport 套件）。":
    "No Bluetooth serial port found. Pair in the system first (Windows creates a virtual COM port); Companion needs the serialport package.",
  "— 選擇藍牙裝置 —": "— Select a Bluetooth device —",
  "已選：{name}": "Selected: {name}",
  名稱: "Name",
  類型: "Type",
  對應分區: "Print zone",
  紙張: "Paper",
  編碼: "Encoding",
  "型號自動偵測：VID {vid} / PID {pid}（唔使手填）": "Model auto-detected: VID {vid} / PID {pid} (no need to type it)",
  "藍牙名稱 / 配對位址": "Bluetooth name / paired address",
  "例如 BT-Printer-AB12": "e.g. BT-Printer-AB12",
  "加入呢部機": "Add this printer",
  分區出單: "Print by zone",
  收據: "Receipt",
  標籤: "Label",

  // ─── 設置頁 · 雲端中繼配對（relay-pairing-panel）───
  "雲端列印中繼（relay）": "Cloud print relay",
  "iPad / 瀏覽器 POS 經雲端將單據轉交店內 Android 中繼機出紙（解決 HTTPS 打唔到 LAN 打印機）。":
    "iPad and browser POS send slips through the cloud to an in-store Android relay for printing (HTTPS cannot reach LAN printers).",
  "未登入 POS 帳號，讀取唔到店舖識別。請先登入，雲端中繼要先知道係邊間店先配到對。":
    "No POS account signed in, so the store identity cannot be read. Sign in first: the cloud relay must know which store it is before it can pair.",
  "已連線：{name}": "Connected: {name}",
  "列印單據會經雲端中繼送到店內 Android 中繼機出紙。":
    "Slips are sent through the cloud relay to the in-store Android relay for printing.",
  "處理中…": "Working…",
  解除配對: "Unpair",
  "喺店內 Android 中繼機開「Macau Print Hub」。":
    "Open \u201cMacau Print Hub\u201d on the in-store Android relay.",
  "用你嘅 POS 登入號碼（8 位電話 + 4 位 PIN）登入並撳「配對」。":
    "Sign in with your POS login (8-digit phone + 4-digit PIN) and tap Pair.",
  "唔使做任何嘢——呢邊會自動配對，中繼機現身即自動接上。":
    "That is all. Pairing happens automatically as soon as the relay appears.",
  "每 5 秒自動檢查一次，直到配對成功為止；成功後會即時停止重試。":
    "Checks every 5 seconds until pairing succeeds, then stops retrying immediately.",
  已解除配對: "Unpaired",
  自動配對已停止: "Auto-pairing stopped",
  "唔會自動重新配對；按下面「配對」先會重新開始自動配對。":
    "It will not pair again automatically. Tap Pair below to restart auto-pairing.",
  停止自動配對: "Stop auto-pairing",
  配對: "Pair",
  "檢查中…": "Checking…",
  立即檢查: "Check now",
  已配對: "Paired",
  "自動配對中…": "Auto-pairing…",
  配對失敗: "Pairing failed",
  尚未配對: "Not paired",
  "配對成功，雲端中繼已連線。": "Paired successfully. The cloud relay is connected.",
  自動配對中: "Auto-pairing",
  "雲端仲未搵到呢間店嘅中繼機。請確認 Android 中繼機已用同一個 POS 登入號碼（8 位電話 + 4 位 PIN）登入並撳咗「配對」":
    "The cloud has not found this store's relay. Check that the Android relay signed in with the same POS login (8-digit phone + 4-digit PIN) and tapped Pair",
  "；偵測到配對成功後會自動接上，唔使手動重試。":
    "; once pairing is detected it connects automatically, so no manual retry is needed.",
  "，再撳「配對」重新開始。": ", then tap Pair to start again.",
  "上次檢查：{time}": "Last checked: {time}",
  "　·　自動配對中：每 5 秒重試一次": "  ·  Auto-pairing, retrying every 5s",
  "　·　自動配對已停止": "  ·  Auto-pairing stopped",
  "技術資料（店舖識別）": "Technical details (store identity)",
  "storeId（本機用緊）：": "storeId in use: ",
  "（無）": "(none)",
  "中繼機 ID：": "Relay ID: ",
  "（未配對）": "(not paired)",

  // ─── 設置頁 · device tab 次層 tab ───
  打印分區: "Print zones",
  打印器: "Printers",

  // ─── 設置頁 · header ───
  "打印機、菜品打印、樓層桌台、支付方式、線上接單都集中在這裡。":
    "Printers, dish printing, floors and tables, payment methods and online orders are all configured here.",
  "切換工作台（重新揀呢部機嘅崗位）": "Switch workstation (pick this device's role again)",
  工作台: "Workstations",
  返回收銀台: "Back to register",

  // ─── 打印機卡（printer-card-v2）───
  已停用: "Disabled",
  已連線: "Connected",
  未連線: "Not connected",
  已連接: "Connected",
  藍牙: "Bluetooth",
  小票機: "Receipt printer",
  標籤機: "Label printer",
  廚房機: "Kitchen printer",
  未知型號: "Unknown model",
  啟用: "Enabled",
  刪除: "Delete",
  "IP 地址": "IP address",
  "USB 連接": "USB connection",
  標籤紙尺寸: "Label size",
  "（機型支援 {min}–{max} mm）": "(model supports {min}–{max} mm)",
  "（超出紙寬限制，放唔落）": " (over the paper width limit, will not fit)",
  "現時尺寸超出現時機型嘅紙寬限制，請改揀其他尺寸":
    "The current size exceeds this model's paper width limit. Please pick another size.",
  "紙張 / 指令集": "Paper / command set",
  用途: "Purpose",
  收銀台收據打印機: "Register receipt printer",
  // ⚠️ 含 `…` 嘅 key **一定要加引號** —— `…`(U+2026) 唔係合法 JS 标识符字符
  "打印中…": "Printing…",
  測試打印標籤: "Test print label",
  測試打印: "Test print",
  尚未添加打印機: "No printer added yet",
  "點擊下方按鈕，一步一步引導添加": "Tap the button below to add one step by step",
  添加打印機: "Add printer",
  未設定: "Not set",
  "62 mm（舊預設）": "62 mm (legacy default)",

  // ─── 標籤紙尺寸 hint（printer-models.ts LABEL_MODEL_PAPER_SIZES）───
  "迷你標籤 / 試管貼": "Mini labels / tube labels",
  "細標籤 / 條碼": "Small labels / barcodes",
  "零售價籤、商品標示": "Retail price tags, product labels",
  "商品標示（較高）": "Product labels (taller)",
  收銀機標準價籤: "Standard till price tag",
  "飲品杯貼、成份表": "Drink cup stickers, ingredient labels",
  "外帶袋、備料標籤": "Takeaway bags, prep labels",
  "物流面單、大標籤": "Shipping labels, large labels",
  "舊系統預設（非業界標準，僅供沿用）": "Legacy system default (not industry standard, kept for compatibility)",

  // ─── 側欄導航 · module-catalog SIDEBAR_MODULES ───
  點餐: "Order",
  訂單: "Orders",
  會員: "Members",
  打印: "Printing",
  報表: "Reports",
  沽清: "Sold out",
  交班: "Shift",
  庫存: "Inventory",

  // ─── 側欄 · 獨立設置連結 ───
  設置: "Settings",

  // ─── 工作台 · label ───
  堂食收銀台: "Dine-in register",
  快餐收銀台: "Fast-food register",
  零售收銀台: "Retail register",
  美容管理: "Beauty salon",
  店員手機: "Staff mobile",
  自助點餐機: "Self-order kiosk",
  後廚屏: "Kitchen screen",
  出餐台屏: "Expo screen",

  // ─── 工作台 · 卡片副標（desc）───
  "每張桌台各自一碼，客人掃碼落單綁定枱號":
    "One QR code per table; guests scan to order and bind to that table",
  "全店一個碼貼櫃檯，客人自助落單、冇枱號":
    "One code at the counter; guests self-order, no table number",
  "掃碼／逐件計，無枱號、無廚房單": "Scan or per-item; no tables, no kitchen tickets",
  "預約、服務、員工排班（美容行業模組）":
    "Appointments, services and staff scheduling (salon module)",
  "手機喺枱邊幫客人落單，送出即出廚房單":
    "Order at the table on a phone; sending fires the kitchen ticket",
  "客人喺呢部機直接落單": "Guests place orders directly on this device",
  "逐件菜撳 ✓（入去先揀分區）": "Tap each dish to serve (pick a zone first)",
  核對整單出餐: "Check the full order before serving",

  // ─── 工作台 · 分組標題 ───
  收銀工作台: "Register workstations",
  "呢部機專用 · 廚房／出餐屏": "This device only · Kitchen / Expo",

  // ─── 工作台選擇頁 ───
  請選擇工作台: "Choose a workstation",
  上次使用: "Last used",
  未開通: "Not enabled",
  "載入中…": "Loading…",
  登出: "Sign out",
  管理員: "Administrator",
  店長: "Manager",
  收銀員: "Cashier",
  "請選擇要進入嘅工作台": "Choose the workstation to enter",
  "呢部裝置今次開機做邊個崗位？入到去之後，可以再喺「設置」入面切換。":
    "What role is this device taking today? You can switch later in Settings.",
  "進入中…": "Entering…",
  "進入 →": "Enter →",
  "進入工作台失敗，請重試。": "Could not open the workstation. Please retry.",
  "搵唔到想用嘅模組？": "Cannot find the module you need?",
  "呢一頁只列出後台已開通嘅模組。如果想用嘅模組灰住或者冇出現，":
    "This page lists only the modules enabled in the back office. If the module you need is greyed out or missing,",
  "請聯絡管理員喺「後台 → 商家 → 模組授權」開通，之後重新登入就會見到。":
    "ask an administrator to enable it under Back office → Merchants → Module access, then sign in again.",
  "記住呢部機嘅選擇（下次開機直接進入，唔使再揀）":
    "Remember this choice on this device (go straight in next time)",
  "仲有 {n} 個模組未開通": "{n} more module(s) not enabled",
  "如需使用，請聯絡管理員喺後台開通。":
    "Please contact an administrator to enable them in the back office.",
  "「{name}」仲未開通。請聯絡管理員喺「後台 → 商家 → 模組授權」開通，之後重新登入就會見到。":
    "\u201c{name}\u201d is not enabled yet. Please contact an administrator to enable it under Back office → Merchants → Module access, then sign in again.",
};

/**
 * 單字徽章英文版 —— 用 2–3 字母縮寫。
 *
 * ⚠️ 闊度限制：桌面側欄 `w-[72px]` → `px-2` → 內容淨 56px；
 * 移動底欄 `min-w-[64px]` + `text-[11px]`。
 * 3 字母 @11px ≈ 20px，安全；4 字母以上（如 "PRNT"）在 `rounded-full` 圓形徽章
 * 會開始橢圓化，所以**全部控制在 ≤3 字母**。
 */
export const SHORT_EN_DICT: Record<string, string> = {
  // 側欄
  點: "ORD",
  單: "ORD",
  會: "MBR",
  印: "PRT",
  報: "RPT",
  沽: "OUT",
  班: "SFT",
  庫: "INV",
  設: "CFG",
  // 工作台
  堂: "DIN",
  快: "FF",
  售: "RTL",
  美: "SAL",
  員: "STF",
  機: "KOS",
  廚: "KIT",
  台: "EXP",
};

/**
 * 守衛用：中文 key 有冇漏翻譯。
 *
 * 正常情況應該係 0。若唔係 0，代表 `en` 字典漏咗 —— `t()` 會 fallback 返中文
 * （唔會 crash，但該句永遠冇英文版）。
 */
export function missingEnKeys(): string[] {
  return Object.keys(ZH_HANT_DICT).filter((k) => !(k in EN_DICT));
}

/** 守衛用：`en` 有冇多咗中文字典冇嘅 key（通常代表 typo 或者刪漏）。 */
export function orphanEnKeys(): string[] {
  return Object.keys(EN_DICT).filter((k) => !(k in ZH_HANT_DICT));
}