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
  // ─── 設置頁 · 版本列（build-version-row.tsx）───
  版本: "Build",
  "線上最新：{id}": "Latest deployed: ",
  // ─── 設置頁 · 自助點餐機模式（kiosk-mode-panel.tsx）───
  "自助點餐機模式（Kiosk）": "Self-order kiosk mode",
  "開啟後，這部裝置每次開啟都會直接進入客人自助點餐介面，唔會顯示收銀台。關閉後回復正常收銀。呢個設定只影響本機，唔會影響其他收銀機。":
    "When on, this device opens straight into the customer self-order screen instead of the register. Turn it off to return to normal. This setting affects only this machine.",
  "已開啟：本機為自助點餐機": "On: this device is a self-order kiosk",
  "已關閉：本機為收銀台": "Off: this device is a register",
  "已綁定店鋪：{name}": "Bound store: {name}",
  "尚未綁定店鋪（請先用「自助點餐」帳號登入一次）":
    "No store bound yet. Sign in once with the self-order account first.",
  "要退出自助點餐模式：喺自助點餐介面右上角按「設定」→「退出自助點餐模式（返回收銀台）」。":
    "To exit self-order mode: open Settings in the top-right of the self-order screen and choose Exit self-order mode (back to register).",
  "⚠️ 本機目前冇職員登入記錄。自助點餐機要做會員扣款，必須保留職員登入狀態；請用職員帳號（唔係 kiosk 綁店帳號）重新登入一次再開啟本模式。":
    "This device has no staff signed in. The kiosk needs member balance deductions, which require a signed-in staff account. Sign in with a staff account (not the kiosk store account) before turning this on.",
  // ─── 設置頁 · 線上接單（merchant-open-pill / merchant-order-config-section）───
  未接通: "Not connected",
  仍有接單通道開住: "Another ordering channel is still open",
  接單狀態未接通: "Ordering status not connected",
  "開啟或暫停{label}": "Turn on or pause {label}",
  "（讀取中…）": " (loading…)",
  "（切換中…）": " (switching…)",
  "（儲存中…）": " (saving…)",
  平台核可: "Platform approval",
  未讀到: "Not read",
  已核可: "Approved",
  "未核可（要搵平台）": "Not approved (contact the platform)",
  商家狀態: "Merchant status",
  接單時段: "Ordering hours",
  "全天接單（未設時段）": "All day (no hours set)",
  "時段內（營業中）": "Within hours (open)",
  "時段外（休息中）": "Outside hours (closed)",
  線上付款方式: "Online payment methods",
  餘額扣點: "Balance deduction",
  到店付款: "Pay at counter",
  "兩種都關住（開唔到店）": "Both off (store cannot open)",
  "線上接單（會員通）": "Online orders (Member Pass)",
  "呢粒「線上接單」係全店線上單嘅總掣：關咗之後客人喺會員通落唔到新單。店內堂食、快餐、自助點餐完全不受影響。改動會即時同步到其他收銀機。":
    "This switch controls all online orders for the store. When off, customers cannot place new orders through Member Pass. In-store dining, fast food and self-order kiosk are unaffected. Changes sync to other registers immediately.",
  接單中: "Open",
  "未讀到 Ledger 接單狀態，請撳「重新整理」。": "Could not read the ordering status from Ledger. Tap Check now.",
  "尚未登入，無法讀取接單狀態。": "Not signed in, so the ordering status cannot be read.",
  "Ledger 接單介面未接通（RPC 未上線，或目前帳號未登入 Ledger）。下面顯示嘅係本機最後同步嘅狀態，暫時無法由 POS 開關。":
    "The Ledger ordering interface is not connected (RPC not deployed, or this account has not signed in to Ledger). What you see below is the last synced state on this machine and cannot be changed from the POS.",
  "跨機即時同步未生效：POS 即時連線指向嘅資料庫冇 POS 表（多數係未設 NEXT_PUBLIC_POS_SUPABASE_URL / _ANON_KEY，或者設完未重新部署）。改完之後，其他收銀機會喺入頁或返前景時才更新 —— 呢個唔影響本機嘅開關。":
    "Cross-machine sync is not active: the database the POS realtime connection points at has no POS tables (usually NEXT_PUBLIC_POS_SUPABASE_URL / _ANON_KEY is unset or was not redeployed). Other registers will pick up the change when opened or brought to the foreground. The switch on this machine is unaffected.",
  "「自動接單」已一併停用：店都關咗，自動接單寫住開都唔會接到單。開返店之後原本嘅自動接單設定仍然保留。":
    "Auto-accept was turned off as well: with the store closed, auto-accept will not take orders even if it is left on. Your previous auto-accept setting is kept and returns when the store reopens.",
  重新整理: "Check now",
  "讀取中…": "Loading…",
  "已載入本機設定。": "Loaded the settings stored on this device.",
  "尚未同步設定。": "Settings have not been synced yet.",
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

  // ─── P1 補漏 · device-settings / scan-mode-panel（2026-10-08 AST 批量）───
  台: "Desk",
  加入: "Add",
  選擇: "Select",
  菜品: "Dish",
  分類: "Category",
  當前分區: "Current zone",
  會打印到: "Prints to",
  內容: "Content",
  編輯: "Edit",
  模式: "Mode",
  規格: "Spec",
  清空: "Clear",
  操作: "Actions",
  說明: "Notes",
  模板: "Template",
  規格組: "Spec group",
  選項數: "Options",
  單選: "Single choice",
  多選: "Multiple choice",
  必選: "Required",
  加價: "Extra charge",
  座位數: "Seats",
  列印: "Print",
  已取消: "Cancelled",
  已退完: "Fully voided",
  全部分類: "All categories",
  批量套用: "Apply to selected",
  上一頁: "Previous",
  下一頁: "Next",
  常用備註: "Quick notes",
  "用於點餐時快速選擇（多選）。": "Quickly pick while ordering (multiple).",
  暫時沒有常用備註: "No quick notes yet",
  "新增常用備註...": "Add a quick note...",
  免單備註: "Waive reasons",
  "結帳頁按「免單」時要選擇的原因（必填）。": "Reason required when tapping Waive at checkout.",
  暫時沒有免單備註: "No waive reasons yet",
  "新增免單備註...": "Add a waive reason...",
  取消備註: "Cancel notes",
  "用於退菜/取消時快速選擇。": "Quickly pick when voiding or cancelling.",
  暫時沒有取消備註: "No cancel notes yet",
  "新增取消備註...": "Add a cancel note...",
  全部退菜後的整單狀態: "Order state after everything is voided",
  "可設定全部退菜後，未結帳整單是標成已取消還是已退完。": "Choose whether an unpaid order becomes Cancelled or Fully voided once all items are voided.",
  折扣備註: "Discount notes",
  "結帳套用折扣時要選擇的原因（必填）。會顯示在報表、訂單紀錄及交班明細。": "Reason required when applying a discount. Shown in reports, order records and the shift summary.",
  暫時沒有折扣備註: "No discount notes yet",
  "新增折扣備註...": "Add a discount note...",
  返結原因: "Reopen reasons",
  "用於返結（反結賬）時選擇退回可編輯狀態的原因，強制填寫以便對帳。": "Reason required when reopening an order back to editable, for auditing.",
  暫時沒有返結原因: "No reopen reasons yet",
  "新增返結原因...": "Add a reopen reason...",
  折扣項目: "Discounts",
  "用於結帳頁「全單折扣」下拉及單品折扣彈窗。每個折扣填名稱與百分比（例如「8折」+「80」），介面唔顯示「%」號。": "Used in the whole-order discount dropdown and the item discount dialog. Give each a name and percentage (for example 8折 + 80). The interface does not show a % sign.",
  暫時沒有折扣項目: "No discounts yet",
  "折扣名稱，例如「8折」": "Discount name, e.g. 10% off",
  "百分比，例如 80": "Percentage, e.g. 80",
  "· 百分比 = 實收比例。80 = 8 折（收 80 元）；50 = 5 折；100 = 冇折扣。": "· Percentage = proportion actually charged. 80 = pay 80% (20% off); 50 = half price; 100 = no discount.",
  "· 單品折扣只影響該菜品，會喺結帳頁該菜品旁顯示原價（刪除線）＋折後價。": "· An item discount affects only that dish. At checkout the original price is shown struck through next to the discounted price.",
  "· 全單折扣套用整張單，折扣金額會喺結帳摘要「折扣」一欄顯示。": "· A whole-order discount applies to the entire order. The discount amount appears as Discount in the checkout summary.",
  "· 修改後請撳右下方「保存折扣」同步到本機同伺服器。": "· After editing, tap Save discounts at the bottom right to sync to this machine and the server.",
  "菜品先分配到打印分區，再由分區打印機或標籤機接收。": "Dishes are first assigned to a print zone, then picked up by that zone printer or a label printer.",
  規格模板: "Spec templates",
  "規格組統一喺呢度定義同管理：模板（成套套用）或獨立規格（單一規格組、菜品自由剔選）；再到「菜品設置 › 編輯規格」組合套用。": "Spec groups are defined here: templates (applied as a set) or standalone specs (one group, dishes pick freely). Apply them per dish under Dish settings > Edit specs.",
  新增模板: "Add template",
  目前沒有規格模板: "No spec templates yet",
  獨立規格: "Standalone specs",
  "唔使開模板，直接建立單一規格組（例如「辣度」「走蔥」）；菜品「編輯規格」可自由剔選加入／移除。": "No template needed. Create a single spec group directly (for example Spice or No spring onion), then tick which dishes use it under Edit specs.",
  新增規格: "Add spec",
  尚未有獨立規格: "No standalone specs yet",
  "規格統一由模板套用：按「編輯規格」揀模板後「保存」即時寫入 server；想自訂規格組請去「規格管理」建立模板。": "Specs are applied from templates: pick a template under Edit specs and Save writes it to the server straight away. To build your own group, create a template under Spec management.",
  新增菜品: "Add dish",
  "搜尋菜品名稱，例如「雞」…": "Search dish names, e.g. chicken",
  清除搜尋: "Clear search",
  菜品名稱: "Dish name",
  "價格（MOP）": "Price (MOP)",
  "時價菜（落單時改價）": "Market price (price set when ordering)",
  "客人可點（掃碼點餐可見）": "Available to customers (visible in QR ordering)",
  無規格: "No specs",
  編輯規格: "Edit specs",
  "套用模板（可選）": "Apply a template (optional)",
  "可選：由模板快速套用；模板喺「規格管理」維護": "Optional: apply quickly from a template. Templates are managed under Spec management.",
  "套用模板…": "Apply a template…",
  "加入獨立規格（喺「規格管理 › 獨立規格」新增／維護；剔選即加入／移除）": "Add standalone specs (create and maintain them under Spec management > Standalone specs; tick to add or remove)",
  "尚未有獨立規格。唔想開模板嘅話，可以直接去「規格管理 › 獨立規格 › 新增規格」建立（例如「辣度」「走蔥」），再返嚟剔選加入。": "No standalone specs yet. Without a template you can create one under Spec management > Standalone specs > Add spec (for example Spice or No spring onion), then tick to add it here.",
  "揀選上方模板後，喺呢度預覽將會套用嘅規格內容。": "Pick a template above to preview the specs it will apply.",
  "填寫菜品資料；保存後即時寫入後台並更新菜單列表。": "Enter the dish details. Saving writes it to the backend straight away and refreshes the menu list.",
  "例如：表嫂雞飯": "e.g. Rice with chicken",
  "（未有分類）": "(no category)",
  "打印位置（分區）": "Print location (zone)",
  "廚房單會按分區派印；分區喺「打印設置」維護。": "Kitchen tickets print by zone. Zones are managed under Printer settings.",
  "（時價菜可留空）": "(may be blank for market price)",
  "選填，配合折扣用": "Optional, used with discounts",
  "留空 = 價格即原價": "Blank means the price is unchanged",
  選填: "Optional",
  "80 = 8折": "80 = 20% off",
  "時價菜：落單時改價": "Market price: price set when ordering",
  "掃碼點餐 / Kiosk 可見": "Visible in QR ordering / kiosk",
  "選填；可套用模板、剔選獨立規格，或快捷新增": "Optional. Apply a template, tick standalone specs, or add one quickly",
  清空規格: "Clear specs",
  "喺呢度直接建立新規格；會自動存入「規格管理 › 獨立規格」供日後復用": "Create a new spec here. It is saved under Spec management > Standalone specs for reuse later.",
  "＋ 新增規格": "+ Add spec",
  "尚未加入規格。": "No specs added yet.",
  "＋ 新增選項": "+ Add option",
  "保存後自動存入「規格管理 › 獨立規格」，其他菜品可剔選復用。": "Saving stores it under Spec management > Standalone specs so other dishes can reuse it.",
  保存並加入: "Save and add",
  "套用規格模板…（模板喺「規格管理」維護）": "Apply a spec template… (templates are managed under Spec management)",
  "獨立規格組（剔選加入）": "Standalone spec groups (tick to add)",
  "未有規格模板／獨立規格組；可直接按上方「＋ 新增規格」快捷新增（自動存入規格管理），或套用模板／到「規格管理」建立。": "No spec template or standalone group yet. Use + Add spec above (it is stored in spec management automatically), or apply a template / create one under Spec management.",
  新增規格組: "Add spec group",
  保存模板: "Save template",
  刪除模板: "Delete template",
  刪除規格: "Delete spec",
  保存規格: "Save spec",
  模板名稱: "Template name",
  "例如：飲品通用規格": "e.g. Common drink specs",
  "尚未有規格組。你可以按下方「新增規格組」開始。": "No spec groups yet. Start with Add spec group below.",
  "規格名（例如：甜度）": "Spec name (e.g. Sweetness)",
  刪除規格組: "Delete spec group",
  "選項（例如：少冰）": "Option (e.g. Less ice)",
  新增選項: "Add option",
  "選擇規格模板（可選；揀選會作為基底取代目前組合）": "Choose a spec template (optional; the chosen one becomes the base and replaces the current combination)",
  "尚未有規格模板。請先去「規格管理 › 新增模板」定義規格，再返嚟套用。": "No spec templates yet. Define one under Spec management > Add template, then come back to apply it.",
  "兩層結構：先樓層，再桌號。": "Two levels: floor first, then table number.",
  新增樓層: "Add floor",
  新增桌子: "Add table",
  "自由文字方式，會記錄到交易裡。預設：現金、Mpay、中銀。": "Free-text methods, recorded on each transaction. Defaults: Cash, Mpay, Bank of China.",
  新增支付方式: "Add payment method",
  "從 Ledger 參考匯入菜單": "Import menu from Ledger",
  "解析結果為 0 個加價選項；若 Ledger 後台有加價，請確認已部署最新版 POS 後再匯入。": "Parsed 0 priced options. If the Ledger back office has extra charges, make sure the latest POS is deployed, then import again.",
  更新菜品: "Updated dishes",
  "Ledger 售罄": "Sold out in Ledger",
  "分類新增／更新": "Categories added / updated",
  刪除本地自建菜單: "Delete locally created menu",
  "本店菜單以 POS 為準。可從 Ledger 一鍵參考匯入線上菜品（名稱／價格／售罄），本地自建菜品會保留。": "This store menu is owned by the POS. You can import online dishes from Ledger as a reference (name / price / sold out); locally created dishes are kept.",
  新增分類: "Add category",
  "快餐掃碼 QR（全店一個）": "Fast-food QR (one for the whole store)",
  "快餐模式全店只用一個碼，客人掃碼後直接落單、每張單獨立（同自助點餐機快餐流程一致）。印出貼喺櫃檯／快餐區。": "Fast-food mode uses a single code for the whole store. Customers scan, order and each order is separate (same flow as the kiosk in fast-food mode). Print it and stick it at the counter or fast-food area.",
  "網址主機（host）": "Host",
  "未取得店鋪編號，請先以商戶帳號登入 / 綁店。": "No store ID yet. Sign in or bind a store with a merchant account first.",
  複製網址: "Copy URL",
  掃碼點餐模式: "QR ordering mode",
  "快餐 · 全店一個碼": "Fast food · one code for all",
  "堂食 · 每枱一個碼": "Dine in · one code per table",
  "呢個模式跟登入模式自動設定，唔需要喺呢一頁揀：用「快餐」登入 = 全店一個碼；用「堂食」登入 = 每張桌台一個碼。": "This mode follows the sign-in mode automatically, so there is nothing to choose here: signing in as Fast food gives one code for the whole store; signing in as Dine in gives one code per table.",
  "要更改模式，請登出後用另一種模式重新登入（登入畫面已經可以揀）。下方只會顯示目前生效嘅 QR；另一邊嘅碼唔會再出現，避免印錯貼紙。": "To change the mode, sign out and sign in again with the other mode (the sign-in screen already offers the choice). Only the QR currently in effect is shown below; the other one no longer appears, so the wrong sticker cannot be printed.",
  "如果呢度顯示嘅模式同你登入嗰陣揀嘅唔一致（例如登入時離線、設定未能上傳），請重新登入一次對應模式。": "If the mode shown here does not match what you chose when signing in (for example you were offline and the setting did not upload), sign in again with the matching mode.",
  "已複製快餐點餐網址。": "Fast-food ordering URL copied.",
  "無法開啟列印視窗，請允許彈出視窗或改用「複製網址」。": "Could not open the print window. Allow pop-ups or use Copy URL instead.",
  "呢個分類暫時冇菜品，可以撳「新增菜品」加入。": "This category has no dishes yet. Use Add dish to add one.",
  "保存中…": "Saving…",
  保存菜單: "Save menu",
  菜品分類: "Dish categories",
  規格管理: "Spec management",
  菜品設置: "Dish settings",
  "掃碼點餐 QR": "QR ordering",
  按枱生成: "Generate one code per table for",
  "碼，印出貼枱。客人掃碼即開手機點餐介面（已帶所屬店鋪）。":
    "and print it for the table. Customers scanning it open the mobile ordering screen with their store already set.",
  "尚未設定桌台，請先到「樓層與桌台」新增。": "No tables set up yet. Add them under Floors & tables first.",
  未命名桌台: "Unnamed table",
  "已複製「{name}」嘅點餐網址。": "Copied the ordering URL for “{name}”.",
  // build-info.ts envLabel() 嘅環境名（build-version-row 用 split/join 逐個替換）
  本機: "local",
  生產: "production",
  預覽: "preview",
  "線上接單只改「開啟接單」一欄，唔會碰接單時段、盒費、折扣、付款方式。自動接單同理，係獨立一欄。兩者都由 Ledger 做真源，POS 只係鏡像 ＋ 廣播。⚠️ 呢個掣只管會員通線上落單；要停店內掃碼點餐／自助點餐機，撳 header 嘅「店內營業」。":
    "This switch only changes the Open for orders column. It does not touch ordering hours, packaging fees, discounts or payment methods. Auto-accept is a separate column. Ledger is the source of truth for both; the POS only mirrors and broadcasts them. Note: this switch covers Member Pass online orders only. To pause in-store QR ordering or the kiosk, use In-store business in the header.",
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
 * 側欄**專用**短標籤（2026-10-08）。
 *
 * 🔴 側欄淨闊 56px（`w-[72px]` − `px-2` ×2）。用 `EN_DICT` 嘅話：
 * `Inventory`(9) / `Sold out`(8) / `Printing`(8) / `Members`(7) 全部**被裁走**
 * （J 2026-10-08 實機截圖：`Members` → `Member`、`Sold out` → `Sold our`）。
 * ⇒ 呢度全部收窄到 ≤6 字母。
 *
 * ⚠️ 淨係俾 `app-sidebar.tsx` 用。同 `打印` 喺設置頁要 "Printer settings"（長），
 * 喺側欄就係 "Print"（短）—— 唔同版面唔能夠共用一個譯文。
 *
 * 🔴 `Sold out`(8) 喺 56px **實測依然被裁**（2026-10-08）⇒ 收到 4 字母 `Sold`。
 * 語意靠上面個 `OUT` 徽章補（`沽` → `OUT`）。
 * ⚠️ `Orders` / `Order` 都係 6 字母 —— 實測啱啱好放得落，唔好再加長。
 */
export const SIDEBAR_EN_DICT: Record<string, string> = {
  點餐: "Order",
  訂單: "Orders",
  會員: "Member",
  打印: "Print",
  報表: "Report",
  沽清: "Sold",
  交班: "Shift",
  庫存: "Stock",
  設置: "Setup",
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