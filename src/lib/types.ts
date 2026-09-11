export type ConnectionType = "lan" | "usb" | "bluetooth";
export type UserRole = "admin" | "manager" | "cashier";

export interface UserPermissions {
  refundOrder: boolean;
  voidItem: boolean;
  /** 返結權位（保留，現階段唔做門控：任何員工可返結，只強制揀原因） */
  reopenOrder?: boolean;
  /**
   * 補打帳單（收據）權位。缺省 = 有（對齊線下：補打收據歷來無角色門控，
   * 任何已登入收銀都做得到）。後台／權限組可個別設 `false` 收起粒掣。
   */
  reprintReceipt?: boolean;
  manageAccounts?: boolean;
}

export interface AccountStore {
  id: string;
  name: string;
  active: boolean;
  code?: string;
  city?: string;
  industry?: "restaurant" | "salon";
  sourceStoreId?: string;
  sourceActive?: boolean;
  manualDeactivated?: boolean;
  effectiveActive?: boolean;
  syncStatus?: "ok" | "error" | "pending";
  lastSyncedAt?: string;
  lastHeartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
  note?: string;
}

export interface AccountPermissionGroup {
  id: string;
  code: string;
  name: string;
  role: UserRole;
  permissions: UserPermissions;
  createdAt: string;
  updatedAt: string;
  note?: string;
}

export interface AccountUser {
  id: string;
  account: string;
  pin: string;
  name: string;
  role: UserRole;
  active: boolean;
  sourceAccountId?: string;
  sourceActive?: boolean;
  manualDeactivated?: boolean;
  effectiveActive?: boolean;
  lastSyncedAt?: string;
  storeIds: string[];
  permissionGroupId?: string;
  permissions: UserPermissions;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  note?: string;
}

export interface BackofficeSyncJob {
  id: string;
  jobType: "stores" | "accounts" | "bindings" | "full";
  scope: string;
  status: "success" | "failed" | "running";
  startedAt: string;
  finishedAt?: string;
  pulledCount: number;
  upsertedCount: number;
  failedCount: number;
  summary: string;
  error?: string;
}

export type PrinterGroup = string;
export type PrinterRole = "zone" | "receipt" | "label";

// 支付方式為自由文字（由「設置」頁配置），用於交易記錄標記
export type PaymentMethod = string;

export type QueueEventType =
  | "ORDER_CREATED"
  | "ORDER_UPDATED"
  | "ORDER_ITEM_VOIDED"
  | "ORDER_SETTLED"
  | "ORDER_DELETED"
  | "DEVICE_CONFIG_UPDATED"
  | "PRINT_JOB_CREATED"
  | "PRINT_JOB_DELETED"
  | "TEST_PRINT_REQUESTED";

export interface MenuSpecOption {
  id: string;
  label: string;
  priceDelta: number;
}

export interface MenuSpecGroup {
  id: string;
  name: string;
  selectionMode: "single" | "multi";
  required: boolean;
  options: MenuSpecOption[];
}

export interface MenuItem {
  id: string;
  categoryId: string;
  name: string;
  /**
   * 揀菜時客人 / 店員見到嘅價錢。
   * - 本地菜品 = 店家自行設定嘅價
   * - Ledger import 菜品 = Ledger 嘅 `price_avos`（已經內含 `promo_rate_permille` 嘅折後價）
   *   → `price` 與 Ledger 嘅「客人實際畀嘅價」對齊，唔另打折
   */
  price: number;
  printerGroup: PrinterGroup;
  specGroups?: MenuSpecGroup[];
  /** 時價菜：落單時強制彈窗輸入當次價錢（用於海鮮 / 每日特色菜等價格浮動項） */
  isMarketPrice?: boolean;
  /** 掃碼點餐 / Kiosk 客人可點：false 時該項唔會出現喺客人介面（預設 true） */
  customerOrderable?: boolean;
  /** 菜品圖片 URL（由 Ledger 線上點餐菜單同步過來；可空，前端有圖先 render） */
  image?: string;
  /**
   * 菜品原價（未折扣前）。可選 — 冇設就當 `price` 已經係原價。
   * - 本地菜品：店家喺菜品編輯設「折扣」時自動填（亦可手動覆寫原價）
   * - Ledger import：Ledger `price_avos` 已折後，所以 `price` 寫折後價、`originalPrice` 寫
   *   `price_avos × 1000 / promo_rate_permille`（倒推 Ledger 嘅 base price）。冇 promo 就兩者相等。
   */
  originalPrice?: number;
  /**
   * 菜品折扣百分比（0-100）。語義同 DiscountPreset.rate / OrderItem.discountRate：
   * `80` = 8折 = 收原價嘅 80%。`undefined` / `100` = 冇折扣。
   * - 落單時若菜本身有 discountRate，會自動 pre-fill 到 OrderItem.discountRate（令出單 / 對帳
   *   同 Ledger 嘅 promo 對齊）；已下單（sent_to_kitchen）後菜品再改 discountRate 唔影響舊單。
   * - 同 OrderItem.discountRate 嘅分別：`OrderItem` 係當下單層嘅折扣（店員落單時可改），
   *   `MenuItem.discountRate` 係菜品層嘅默認折扣（Ledger / 店家設定）。
   */
  discountRate?: number;
}

export interface MenuCategory {
  id: string;
  name: string;
}

export interface StoreTable {
  id: string;
  name: string;
  area: string;
  floorId?: string;
  /** 該桌可容納座位數（人數）；桌台設置新增／編輯桌時填寫 */
  capacity?: number;
  /** 返結 temp 枱標記（結帳／取消後由 removeReopenTempTable 清除） */
  isReopenTemp?: boolean;
  /** 關聯嘅返結訂單 id（供移除 temp 枱用） */
  reopenOrderId?: string;
}

export interface FloorConfig {
  id: string;
  name: string;
  tables: StoreTable[];
}

export interface PosRules {
  orderFlow: "send_then_pay";
  allowSplitBill: boolean;
  allowMemberLookup: boolean;
  taxRate: number;
  serviceChargeRate: number;
  paymentMethods: PaymentMethod[];
}

export interface PosBootstrap {
  sourceVersion: number;
  storeId: string;
  storeName: string;
  /** 店家電話（顯示喺收據抬頭，類似 57.doc 嘅「電話：xxx」）。可選 — 舊單冇就 fallback 唔顯示。 */
  storeTel?: string;
  currency: string;
  categories: MenuCategory[];
  menuItems: MenuItem[];
  tables: StoreTable[];
  rules: PosRules;
  printerGroups: PrinterGroup[];
  lastUpdatedAt: string;
  /**
   * 呢間店「未有餐牌」（pos_bootstrap_config 冇 row）。
   *
   * 2026-09-10 掃碼點餐審查 P1-5：舊版未知店會回 `mockBootstrap`（示範店菜式），
   * 客人掃碼會見到 demo 餐牌並且**可以真金白銀落單入真店** → 錯菜錯價。
   * 改為回 `menuUnavailable: true` + 空餐牌，前端顯示「餐牌準備中，請聯絡職員」並停用落單。
   * demo 餐牌只保留俾開發環境（`NODE_ENV !== "production"`）。
   */
  menuUnavailable?: boolean;
}

export interface DevicePrinterConfig {
  id: string;
  role: PrinterRole;
  zoneId?: string;
  connectionType: ConnectionType;
  name: string;
  model?: string;
  paperSize?: string;
  ipAddress?: string;
  /** Raw TCP port for LAN ESC/POS (default 9100) */
  lanPort?: number;
  /** ESC/POS 編碼（每台可配；預設 GB18030。可選: gb18030 / gbk / big5 / utf-8） */
  charset?: string;
  /** 中文（Kanji）倍大指令：商頌 POS-80 等機要用 GS ! n；標準 ESC/POS 機用 FS ! n。
   *  空缺 = 渲染器預設 GS ! n（即「接上就用」嘅安全值，已喺商頌 POS-80 實機對照測試證實）。 */
  kanjiEnlarge?: "FS!" | "GS!";
  /** 行距覆寫（docs/74 §8.2）：ESC/POS `ESC 3 n`，單位 1/180"。
   *  渲染器預設 s/m=30、l=60（l 雙高 → 行距 double，避免大字上下行重疊變扁）。
   *  個別機型實測若仍微微重疊 → l 試 64–66；太疏 → 試 50–54（安全 range 30–72）。
   *  填空缺 = 用渲染器預設。改呢度唔使 rebuild APK / Companion（經 job payload 帶過去）。 */
  lineSpacing?: { s?: number; m?: number; l?: number };
  /** A 通道（OS spooler RAW）打印端口：driverless USB Printer Class（如商頌 POS-80 / Windows USB001 虛擬埠）
   *  填 "USB001"（Windows）/ CUPS 隊列名（macOS·Linux）。有值時 Companion 優先用 OS spooler 打，
   *  失敗再回落 node-usb B 通道。空缺 = 直接用 B 通道。 */
  usbPort?: string;
  /** USB 打印機 VID（自動偵測，商家唔使手填；Meituan 式型號表對照） */
  usbVendorId?: string;
  /** USB 打印機 PID（自動偵測） */
  usbProductId?: string;
  /** 藍牙打印機名稱 / 配對位址 */
  bluetoothName?: string;
  /** 每次打單打印份數（1–9）；未設定或 ≤1 視為 1 份 */
  copies?: number;
  /** true = 由 Companion 自動偵測加入（唔經手動輸入 VID/PID） */
  autoDetected?: boolean;
  // ── USB 連接（connectionType === "usb" 時使用）──
  /** USB vendor id（hex string，例如 "0x1234"） */
  /** USB product id（hex string，例如 "0x5678"） */
  // ── Bluetooth 連接（connectionType === "bluetooth" 時使用）──
  /** Bluetooth MAC / 裝置地址（例如 "AA:BB:CC:DD:EE:FF"） */
  bluetoothAddress?: string;
  /** Bluetooth 裝置名（配對/列舉顯示用） */
  enabled: boolean;
}

export interface DeviceConfig {
  deviceId: string;
  terminalName: string;
  storeId: string;
  printers: DevicePrinterConfig[];
  /**
   * 交班單指定打印機（2026-09-08）：結數交班明細由邊台打印機出紙。
   * 空缺 / 指定機被停用或刪除 = fallback 跟隨第一台啟用嘅收據打印機（role === "receipt"）。
   */
  shiftPrinterId?: string;
  updatedAt: string;
}

// ── ESC/POS 模板（真實可打印子集） ──
// 熱敏機：單色、字型有限、無 CSS 顏色 / 邊框 / 絕對定位。
// 所以模板只攜帶「開關 + 字型大小 + 粗體 + 對齊」呢啲 ESC/POS 真係印到嘅設定，
// 設計介面同實際輸出 100% 一致（見 escpos-template.ts / escpos-render.ts）。
export type EscPosAlign = "left" | "center" | "right";
export type EscPosSize = "s" | "m" | "l";
/** 菜品明細（items）區塊嘅清單排版：inline=品名+數量左右排列（舊式）；card=分層卡片（品名加粗→名下虛線→規格成組縮排）；stacked=完全直向。預設 "card"（見 docs/67）。 */
export type EscPosItemsLayout = "inline" | "card" | "stacked";

export interface EscPosBlockStyle {
  visible: boolean;
  size: EscPosSize;
  bold: boolean;
  align: EscPosAlign;
  /** 次級 sub-line（菜品規格 / 備註）字型大小；預設 "s"。ESC/POS 只有 3 檔，避免規格細到睇唔到。可選——舊模板缺省當 "s"。 */
  subSize?: EscPosSize;
  /** 菜品明細清單排版；只有 items 區塊有意義。可選——舊模板缺省當 "card"。 */
  layout?: EscPosItemsLayout;
}

export type ReceiptSectionId =
  | "store_name"
  /** 店家電話（同 57.doc「電話：xxx」一欄；visible false 時省略）。可選 — bootstrap 冇 storeTel 就唔顯示。 */
  | "store_tel"
  | "order_no"
  | "table_name"
  | "order_time"
  | "checkout_time"
  /** 服務員（操作人顯示名）；可選。見 docs/88 §5.4 */
  | "server"
  /**
   * 分格線（`----` 分隔線）。
   *
   * ⚠️ 呢個係**設定型區塊**：佢自己唔會印一行文字，而係決定「自動分格線」（菜品明細前後、
   * card 排版每件菜之間）嘅**粗細**（`size`）同開關（`visible`）。
   * 喺 `order` 入面嘅位置唔影響出紙位置（renderer 一律跳過佢，唔會 emit 行）。
   *
   * 由來：實體分格線係一行 `-` 字符，而打印機嘅中文放大狀態（`GS !` / `FS !`）係**常駐**嘅，
   * `ESC !` 清唔走 → 出紙時會跟住上一行（收據 = 菜品主名）嘅放大狀態變成雙闊，
   * `cols` 個 dash 一行放唔落 → 打印機**自動折行** → 一條線變兩條（2026-09-10 實紙 bug）。
   * 而家三邊（POS 預覽 / Companion / APK）同一口徑：
   * ① 印線前先清放大殘留；② dash 數量 = `dividerDashCount(size, cols)`（放大就減半）；
   * ③ `size` 淨係控制條線幾粗，**任何 size 都只佔一行**。
   * **舊模板冇呢個區塊 → renderer 沿用「繼承上一行 size」嘅舊行為（dash 數量照樣減半以免折行）。**
   */
  | "divider"
  | "items"
  /** 單品折扣明細：每件菜如有 discountRate，打印「折扣率 X% / 折讓 $Y」一行（仿 57.doc 嘅 sub-line）。 */
  | "discount_breakdown"
  | "subtotal_before_discount"
  /** 服務費（serviceChargeAmount）— 之前收據唔打，現在跟 57.doc 嘅習慣補返。 */
  | "service_charge_amount"
  /** 稅金（taxAmount）— 同上。 */
  | "tax_amount"
  | "rounding_amount"
  | "discount_amount"
  | "total"
  /** 顧客實付現金（cashTendered）— 同 57.doc 「实收」。 */
  | "cash_tendered"
  /** 找零（changeAmount）— 同 57.doc 「找零」。 */
  | "change_amount"
  | "payment_method"
  | "order_note"
  /**
   * 收據二維碼（商家自訂網址 → QR）。同 `items` 一樣係**特殊區塊**：
   * 內容唔喺 `PrintJob.content`（嗰度只放純文字），而係讀 `PrintJob.qr`。
   * 網址空白 / 編碼失敗 → 無 `qr` 欄位 → renderer 同預覽都自動略過（唔會印空框）。
   */
  | "qr_code"
  | "footer";
export type LabelSectionId =
  | "header"
  | "item_name"
  | "temperature"
  | "cup_type"
  | "sugar"
  | "ice"
  | "sugar_tag"
  | "ice_tag"
  | "addons"
  | "specs"
  | "item_note"
  | "order_no"
  | "footer";
export type KitchenSectionId =
  | "store_name"
  | "order_no"
  | "table_name"
  | "order_type"
  | "time"
  /**
   * 分格線（設定型區塊，語義同 ReceiptSectionId 嘅 `divider`）：控制自動分格線嘅粗細 / 開關。
   * 同收據一樣：**任何 size 都只佔一行**（dash 數量 = `dividerDashCount()`）。
   */
  | "divider"
  | "items"
  | "order_note"
  | "footer";
// ⚠️ 已剷走 `server`（店員）同 `customer_count`（人數）兩個區塊（2026-09-10）：
// `buildKitchenContent()` 對呢兩個 key 一路回硬編空字串 `""`，`print-jobs.ts` 亦
// 從來冇傳過資料 → 就算商家喺設計頁撳「顯示」都係印唔到（死開關，只會報錯案）。
// 三個下游 repo 只 loop `snapshot.blocks`，所以剷 id **唔使改佢哋**。
// 舊 localStorage / 雲端 record 殘留呢兩個 id 嘅話，`normalizeKitchenTemplate()`
// 會靠「只認 `KITCHEN_SECTION_META` 入面嘅 id」自動清走。
/**
 * 交班結算單模板嘅區塊 id（2026-09-10 新增「交班模板」）。
 *
 * 交班單同其他單據最大分別：**冇菜品明細（items）**，內容全部係匯總數字。
 * 所以呢度冇 `items` 區塊，而係一項一個區塊（營業額 / 應收 / 實收 …），
 * 商家可以逐項決定印唔印、字型大細、順序。
 *
 * `section_*` 係**分節標題**區塊（例如「— 店內（今日）—」）。呢啲標題同一般區塊一樣
 * 由 `content[id]` 帶文字，所以商家可以自己改字（例如改成「堂食（今日）」），
 * 亦可以整項熄咗。原本硬編成 `"— 店內（今日）—"` 一行嘅寫法已由模板取代。
 *
 * `payment_breakdown` 係**動態多行**區塊：實際有幾個支付方式就有幾行，
 * 內容用 `\n` 串埋一個字串（同收據 `discount_breakdown` 同一手法），
 * 預覽 `whitespace-pre-wrap`、出紙 `buf.line()` 兩邊都會照印成多行。
 *
 * ⚠️ **刻意冇 `divider` 區塊**：三個 repo 嘅 renderer 都係「分格線跟住 `items` 區塊
 * 自動生成」（`pushDivider()` / `rule()` 只喺 items 分支被 call）。交班單冇菜品明細，
 * 加咗 `divider` 落去會變成一個**撳咗冇反應**嘅死開關，只會令商家困惑。
 * 交班單嘅視覺分段由 `section_*` 標題行（例如「— 店內（今日）—」）負責。
 */
export type ShiftSectionId =
  /** 抬頭（交班單標題）；文字 = 模板 `headerText`，商家可自改（例如「＊＊＊ 日結單 ＊＊＊」）。 */
  | "header"
  | "store_name"
  | "shift_no"
  | "employee"
  | "close_time"
  | "open_time"
  /** 分節標題：店內（今日）。 */
  | "section_store"
  | "settled_count"
  | "revenue"
  | "receivable_total"
  | "paid_total"
  | "prepaid"
  | "refund"
  /** 分節標題：會員通線上（今日）。 */
  | "section_online"
  | "online_order_count"
  | "online_paid"
  | "online_balance"
  | "online_in_store"
  | "online_total"
  /** 分節標題：支付方式分項（線下 POS）。 */
  | "section_payment"
  /** 動態多行：每個支付方式一行（`method：應收 X / 實收 Y · N 張`）。 */
  | "payment_breakdown"
  /** 分節標題：買貨成本（今日）。 */
  | "section_purchase"
  | "purchase_paid"
  /** 分節標題：現金箱核對。 */
  | "section_cash"
  | "expected_cash"
  | "actual_cash"
  | "cash_diff"
  | "note"
  | "footer";

export interface ReceiptTemplate {
  blocks: Record<ReceiptSectionId, EscPosBlockStyle>;
  order: ReceiptSectionId[];
  footerText: string;
  /**
   * 收據底部二維碼嘅網址（例如會員連結 / 電子發票 / 網上點餐）。
   *
   * 空白 = 唔印二維碼（連 `qr_code` 區塊都唔會出，唔會留空白位）。
   * 呢個係**模版層級**設定：`receipt` 同 `kiosk` 係兩個獨立槽位，可以各自填唔同網址。
   *
   * ⚠️ 三個 repo 都**唔好**自己 encode QR：POS 端統一用 `encodeQrPayload()` 編成點陣
   * 放落 `PrintJob.qr`，Companion / APK 淨負責「點陣 → ESC/POS 點陣圖」。
   * 咁先可以保證「設計介面 == 螢幕預覽 == 實際出紙」三者係同一個矩陣。
   */
  qrUrl?: string;
  /**
   * 收據二維碼嘅**打印大小**（`s` 細 / `m` 中 / `l` 大）。
   *
   * 同 `qrUrl` 一樣係模版層級設定：`receipt` / `kiosk` 各自獨立存一份。
   * 控制打印模板內（即時預覽）二維碼圖像嘅尺寸；細 / 中 / 大對應逐步放大。
   * 缺省 = `"m"`（中）。可選 — 舊模板未存有呢欄時設計介面會補返預設。
   */
  qrSize?: EscPosSize;
}

/**
 * 標籤紙嘅**舊預設紙寬**（毫米）。
 *
 * ⚠️ 2026-09-10 查證：62mm **唔係**熱感標籤嘅業界標準闊度。
 * 佢只出現喺(1) 收銀熱敏紙卷闊度列表（37/50/57/58/60/62/70/80mm）同
 * (2) Brother DK 62×100mm 呢類 niche 標籤。真正餐飲標籤主流係 50 / 58 / 60 / 70 / 80 / 100mm。
 * 所以而家改由商家喺 `LABEL_PAPER_PRESETS` 度揀；62mm 降為「舊系統預設」保留項
 * （直接剷走會踢爛手上真係有 62mm 卷嘅商戶）。
 *
 * 而家呢個常數**淨係當 fallback 用**，新增邏輯一律讀 `labelPaperPreset()`。
 */
export const LABEL_STANDARD_WIDTH_MM = 62;

/**
 * 標籤紙尺寸選項（2026-09-10）。
 *
 * `columns` = font A / 203dpi 每行可印字符數：`floor((紙闊 − 8mm 導軌) ÷ 1.5mm)`。
 * 58mm→32 / 80mm→48 兩點同 `print hub` `EscPosRenderer.kt` 既有的
 * `PAPER_COLUMNS_58MM` / `RECEIPT_PAPER_COLUMNS` 對齊。
 */
export interface LabelPaperPreset {
  id: string;
  /** UI 顯示用（「50 × 30」）。 */
  label: string;
  widthMm: number;
  heightMm: number;
  /** font A（s 檔）每行字符數；m / l 雙闊 → 一半。 */
  columns: number;
  /** 典型用途，畀商家對號入座。 */
  hint: string;
}
export const LABEL_PAPER_PRESETS: LabelPaperPreset[] = [
  { id: "40x30", label: "40 × 30", widthMm: 40, heightMm: 30, columns: 21, hint: "細標籤 / 條碼" },
  { id: "50x30", label: "50 × 30", widthMm: 50, heightMm: 30, columns: 28, hint: "零售價籤、商品標示" },
  { id: "58x40", label: "58 × 40", widthMm: 58, heightMm: 40, columns: 32, hint: "收銀機標準價籤" },
  { id: "60x40", label: "60 × 40", widthMm: 60, heightMm: 40, columns: 34, hint: "飲品杯貼、成份表" },
  { id: "70x50", label: "70 × 50", widthMm: 70, heightMm: 50, columns: 41, hint: "外帶袋、備料標籤" },
  { id: "80x50", label: "80 × 50", widthMm: 80, heightMm: 50, columns: 48, hint: "後廚叫號、大標籤" },
  { id: "100x75", label: "100 × 75", widthMm: 100, heightMm: 75, columns: 61, hint: "外送箱、物流面單" },
  { id: "62mm", label: "62 mm", widthMm: 62, heightMm: 40, columns: 36, hint: "舊系統預設（非業界標準，僅供沿用）" },
];
/** 缺省：保留 62mm，唔改動任何現有商戶嘅版面。 */
export const DEFAULT_LABEL_PAPER_ID = "62mm";

export interface LabelTemplate {
  blocks: Record<LabelSectionId, EscPosBlockStyle>;
  order: LabelSectionId[];
  headerText: string;
  footerText: string;
  /**
   * 標籤紙尺寸（`LABEL_PAPER_PRESETS` 嘅 id）。缺省 = `DEFAULT_LABEL_PAPER_ID`。
   *
   * ⚠️ `normalizePosLocalSettings()` 係**逐欄重建** `label`（唔係展開合併），
   * 所以呢個欄一定要喺嗰度手動帶返，否則一 reload 就被剷走
   * —— 同當年 `receipt.qrUrl` 被靜靜剷走係同一個坑。
   *
   * 只影響**網頁預覽同分格線闊度**：標籤本來就冇 items / 價錢，全部係純文字行，
   * 三個通道照印同一串 bytes，所以改呢個值唔使改跨 repo。
   */
  paperSize?: string;
}
export interface KitchenTemplate {
  blocks: Record<KitchenSectionId, EscPosBlockStyle>;
  order: KitchenSectionId[];
  headerText: string;
  footerText: string;
}

/**
 * 交班結算單模板（2026-09-10 新增，第五個槽位）。
 *
 * 結構對齊 `KitchenTemplate`（`blocks` + `order` + `headerText` + `footerText`），
 * 所以設計介面、`buildSnapshot()`、雲端同步、normalize 全部行返同一套既有機制，
 * 唔使為交班單另建一套。
 *
 * ⚠️ `headerText` 係**經 `header` 區塊出紙**，唔係靠 `PrintTemplateKind` 嘅標題表：
 * 三個 repo（POS / desktop-companion / print-agent-android）嘅 `TITLE` 表只認
 * `receipt | label | kitchen`，傳 `"shift"` 會 fall through 去空字串（唔會印錯標題，
 * 但亦唔會自動印「交班單」）。所以標題一定要靠 `header` 區塊自己帶，
 * 好處係**商家可以自己改標題文字**，而且三個 repo 零改動。
 */
export interface ShiftTemplate {
  blocks: Record<ShiftSectionId, EscPosBlockStyle>;
  order: ShiftSectionId[];
  headerText: string;
  footerText: string;
  /**
   * 分節標題文字（商家可自訂，例如把「— 店內（今日）—」改成「— 堂食（今日）—」）。
   *
   * 只對 `section_*` 區塊有意義；缺省（key 唔存在 / 空字串）時由
   * `SHIFT_SECTION_TITLES` 補返出廠文字。呢個係**模板層級**欄位而唔係 content，
   * 因為佢係「設計」而唔係「當日數據」——同一套排版每次交班都應該印同一句標題。
   */
  sectionTitles: Partial<Record<ShiftSectionId, string>>;
}

/**
 * 交班模板**範本**（商家自建、可命名嘅一整套排版）。
 *
 * 語義同 `PosLocalSettings.specTemplates` 一致 —— 係一個「範本庫」：
 * 商家可以新增 / 改名 / 刪除 / 套用。**庫入面嘅範本唔係即時生效嘅**，
 * 生效嘅係 `PrintTemplates.shift` 呢個「工作中」模板：
 * - 「儲存為範本」= 把目前工作中嘅排版存成一個具名範本；
 * - 「套用」      = 把範本內容**拷貝**落 `PrintTemplates.shift`（之後嘅編輯唔會影響範本）；
 * - 「刪除」      = 只由庫移除，唔會動到目前生效中嘅排版（防止誤刪令出紙返去預設）。
 *
 * 咁做係刻意嘅：如果範本同生效模板係同一份物件，任何一次微調都會改到範本本身，
 * 商家就再冇「還原返上一個版本」嘅機會。
 */
export interface ShiftTemplateVariant {
  id: string;
  name: string;
  template: ShiftTemplate;
}

/**
 * 交班結算單嘅**資料快照**（出紙內容嘅唯一真源）。
 *
 * 由 `shift-page.tsx` 喺進入結數預覽（step3）時固化，之後「預覽 / 打印 / 跳過」都用同一份，
 * 保證「預覽 == 紙本 == 交班記錄」。同時亦係交班記錄（`shiftHistory`）嘅持久化形狀。
 *
 * 放喺 `types.ts` 而唔係 `shift-page.tsx`：`escpos-template.ts` 嘅 `buildShiftContent()`
 * 要讀佢，而 component 唔應該被 lib 反向 import（會成 circular dependency）。
 */
export type ShiftSettlementSnapshot = {
  /** 交班時間（進入預覽一刻固化，交班記錄同紙本都用呢個）。 */
  closedAt: string;
  /** 單號序號：`YYYY-MM-DD-NN`（NN = 當日第幾班）。 */
  shiftNo: string;
  storeName: string;
  employee: string;
  openedAt?: string;
  store: {
    count: number;
    revenue: number;
    receivableTotal: number;
    paidTotal: number;
    prepaid: number;
    refundCount: number;
    refundAmount: number;
  };
  /** 會員通線上（Ledger）——未登入 / 冇資料時 null（紙本成組唔印）。 */
  online: {
    orderCount: number;
    paidMop: number;
    balancePaidMop: number;
    inStorePaidMop: number;
  } | null;
  payments: { method: string; receivable: number; paid: number; count: number }[];
  /** 今日買貨成本——冇做成本記錄時 null。 */
  purchase: { paid: number; unpaid: number } | null;
  cash: { expected: number; actual?: number; diff?: number };
  // 冇 G 區（待同步/技術狀態唔上紙本），但歷史記錄仍要記，跟住快照走。
  pendingEvents: number;
  failedEvents: number;
  skippedEvents: number;
  pendingPrints: number;
  note: string;
};

export interface PrintTemplates {
  receipt: ReceiptTemplate;
  label: LabelTemplate;
  kitchen: KitchenTemplate;
  /**
   * 自助點餐機模版（商家喺「打印」頁第四個分頁設定）。
   *
   * 結構同 `receipt` 一樣（`ReceiptTemplate`），但係**獨立槽位**：商家改佢唔會影響收銀台收據。
   * 預設內容係 `DEFAULT_RECEIPT_TEMPLATE` 嘅深拷貝（規格 8：小票格式同現有小票完全一致，無需額外設計）。
   *
   * ⚠️ 渲染時 `buildSnapshot()` 嘅 kind **必須傳 `"receipt"`**，唔可以傳 `"kiosk"`：
   * 三個 repo 嘅 TITLE map（`src/lib/escpos-render.ts`、`companion-server.mjs`、
   * print-agent-android `EscPosRenderer.kt`）只認 receipt / label / kitchen，
   * 傳 `"kiosk"` 會 fall through 去空字串 → 冇咗「＊＊＊ 收據 ＊＊＊」抬頭，格式就同收據唔一致。
   * 用 `"receipt"` 嘅話三個 repo 全部原封不動，零跨 repo 改動。見 docs/87 §2.3。
   */
  kiosk: ReceiptTemplate;
  /**
   * 交班結算單模板（第五個槽位，2026-09-10）。
   *
   * 未加呢個槽位之前，交班單係由 `shift-page.tsx` 硬編成一串文字、塞入 `PrintJob.items`
   * （每行 `quantity: 1`）—— job 冇 `template` 快照 → 打印通道退回硬編廚房渲染器 →
   * 出紙變成「【廚房單】標題 + 每行 x1 + 冇字型對齊」（見 docs/103）。
   * 而家有模板快照之後，交班單同收據一樣走 `renderEscPosLines()`，
   * 「設計介面 == 螢幕預覽 == 實際出紙」。
   */
  shift: ShiftTemplate;
}

export type PrintTemplateKind = "receipt" | "label" | "kitchen" | "shift";

/**
 * 二維碼點陣（三個 repo 共用嘅序列化格式）。
 *
 * `bits` 係逐行、由左至右嘅 `'0'` / `'1'` 字串，長度 = `size × size`，`'1'` = 黑點。
 * 用字串而唔係 `boolean[][]`：JSON 體積細一個數量級，Kotlin / JS 都直接 index 到。
 *
 * **唔包 quiet zone**（QR 規範要求四格白邊）—— 由 renderer 出紙時自己補，
 * 預覽（SVG）亦補同一個 `QR_QUIET_MODULES`，兩邊先會一致。
 */
export interface QrPayload {
  /** 邊長（modules），未計 quiet zone。v1=21 … v6=41。 */
  size: number;
  /** 逐行 bit 字串，長度 = size × size；'1' = 黑點。 */
  bits: string;
}

// 拼接落每張 PrintJob 嘅自包含、可序列化快照；renderer 印嗰時直接讀佢，唔使回頭查 settings。
export interface EscPosTemplateSnapshot {
  kind: PrintTemplateKind;
  blocks: Array<{ id: string; visible: boolean; size: EscPosSize; bold: boolean; align: EscPosAlign; subSize?: EscPosSize; layout?: EscPosItemsLayout }>;
  /**
   * 每行可印字符數（font A / 203dpi）。58mm → 32，80mm → 48，標籤跟紙尺寸 preset。
   *
   * 2026-09-10 加嚟**統一三個 repo**：以前 `print hub` 自己按 `printer.paperSize`
   * 判斷 58mm→32，`desktop-companion` 同 POS 預覽就硬編 48 —— 同一張單喺
   * APK / PC / 網頁會出三種唔同闊度嘅排版。
   * 而家由 POS 計一次寫入快照，下游**直接讀**，唔好再各自判斷（見 `buildSnapshot`）。
   *
   * 舊快照冇呢欄 → 下游 fallback 去自己嘅預設（48 / 依 paperSize），行為不變。
   */
  cols?: number;
}

/** 折扣預設（設置 → 折扣 tab）。rate = 百分比數字，例如 8 折填 80（介面唔顯示 %）。 */
export interface DiscountPreset {
  id: string;
  label: string;
  /** 折扣百分比（0-100）。80 = 收 80 元 / 原價 100；0 = 免費；100 = 冇折扣。 */
  rate: number;
}

export interface PosLocalSettings {
  floors: FloorConfig[];
  paymentMethods: string[];
  /** 折扣預設清單（設置 → 折扣 tab）。結帳頁「全單折扣」下拉 + 單品折扣彈窗共用。 */
  discounts: DiscountPreset[];
  menuPrinterOverrides: Record<string, PrinterGroup>;
  printZones: Array<{
    id: string;
    name: string;
  }>;
  specTemplates: Array<{
    id: string;
    name: string;
    specGroups: MenuSpecGroup[];
  }>;
  /**
   * 獨立規格組（2026-09-09）：喺「規格管理」直接建立嘅單一規格組（例如「辣度」「走蔥」），
   * 唔屬於任何模板。菜品「編輯規格」可以獨立剔選加入／移除，同模板自由組合。
   * 菜品上存嘅係 snapshot 拷貝（同模板一致）：之後改呢度唔會追溯已套用菜品。
   */
  standaloneSpecGroups: MenuSpecGroup[];
  printTemplates: PrintTemplates;
  /**
   * 交班模板範本庫（2026-09-10「交班模板」功能）。
   *
   * 商家可以建立多套交班結算單排版並命名（例如「日結單」「現金班」「外賣班」），
   * 隨時套用其中一套。**庫入面嘅範本唔係即時生效嘅**——生效嘅係
   * `printTemplates.shift`（工作中模板）；「套用」= 把範本拷貝入去。
   *
   * ⚠️ 唔可以喺 `normalizePosLocalSettings` 漏咗 whitelist：漏咗就會 reload 時被剷光
   * （同 `receipt.qrUrl` / `standaloneSpecGroups` 嘅歷史教訓一樣）。
   */
  shiftTemplatePresets: ShiftTemplateVariant[];
  /**
   * 上次「套用」嘅範本 id（對應 `shiftTemplatePresets[].id`）。
   *
   * 純粹係介面提示用（顯示「目前排版基於範本：XXX」），**唔參與出紙邏輯**。
   * 因為出紙一律讀 `printTemplates.shift`，呢個 id 對唔上唔會影響任何嘢；
   * 範本被刪除後殘留一個孤兒 id 亦只會令提示消失（見 `resolveActiveShiftPresetName`）。
   * 空字串 = 未曾套用過任何範本（例如商家由預設直接開始改）。
   */
  activeShiftTemplateId: string;
  /** 常用備註（點餐時快速選擇，多選）。 */
  notePresets: string[];
  /** 取消備註（退菜 / 取消時快速選擇）。 */
  cancelNotePresets: string[];
  /**
   * 免單備註：結帳頁撳「免單」時要揀／輸入嘅原因（設置 → 備註 → 免單備註）。
   * 同 cancelNotePresets 分開：退菜係「取消」，免單係「全額減免後照結帳」，語意唔同、
   * 對帳口徑亦唔同（免單單會照出收據、計入營業額但實收 0）。
   */
  compNotePresets: string[];
  /** 返結（反結賬）可選原因清單，設置 → 備註 可增刪 */
  reopenReasons: string[];
  fullVoidBehavior: "cancelled" | "refunded";
  onlineOrderSettings: {
    autoAccept: boolean;
  };
  /**
   * 「自動接自助單」開關（取代舊嘅 `kioskKitchenMode`，見 docs/87 §4.1）。
   * 堂食與快餐共用同一粒開關；外賣（Ledger 線上訂單）唔受影響，繼續用 `onlineOrderSettings.autoAccept`。
   *
   * - `true`（**預設**，規格 5）：免確認，客人落單後直接出廚房單
   * - `false`：自助點餐單排入「待確認」，等收銀台撳「確認」先用代客下單流程出單
   *
   * ⚠️ 真源喺 DB（`pos_kiosk_settings.self_order_auto_accept`，按 `store_id`），
   * 本機呢個值只係快取 —— Kiosk 落單時會向 server 讀一次。
   * 因為舊嘅 `kioskKitchenMode` 係由 Kiosk 自己嘅 localStorage 讀，而 Kiosk 從來冇設定 UI，
   * 結果永遠係 `"auto"` → 開關係死 code。見 docs/87 §9 P0 #4。
   */
  autoAcceptSelfOrder: boolean;
  /**
   * 「自動打印」開關（點餐介面 · 堂食／外賣模式）。
   *
   * - `true`（**預設**）：落單自動出廚房單／飲品標籤單，結帳自動出收據。
   * - `false`：收銀台落單／結帳**完全唔會自動**產生任何打印任務。
   *
   * 範圍（2026-09-05 用戶確認：只管收銀台點餐流程）：
   * 只覆蓋 `sendToKitchen()`（廚房單 + 標籤單）同 `printReceipt()`（結帳收據）。
   * 退菜單／返結單／退款單／線上單接單／自助點餐機小票**唔受影響**。
   *
   * 手動掣優於開關：點餐介面嘅「打印廚房單」/「打印收據」係用家當下嘅明確意圖，
   * 就算開關關閉都照印（見 pos-app.tsx `printKitchenTicketNow` / `printReceiptNow`）。
   *
   * 真源喺本機 localStorage（`PosLocalSettings`，store scope）——呢個係「呢部收銀機」
   * 嘅出單行為，同一間店可以前台出單、後台唔出單，唔可以擺落全店共用嘅 DB 設定。
   */
  autoPrint: boolean;
  /**
   * 「打印開關設置」section 用嘅細粒度總開關（2026-09-08 引入）。
   *
   * 每個 kind 對應一種打印**內容類型**，由商家喺設備設置頁按需關閉。覆蓋舊版單一
   * `autoPrint` 開關（舊版只控制廚房單 + 標籤單 + 結帳收據，新版可逐項控制）。
   *
   * - `true`（**預設**）：自動流程（落單/加單/結帳/退菜/退桌/返結/線上單接單+取消+完成
   *   / 自助機小票 / 交班單）照常產生對應打印任務。
   * - `false`：對應自動流程**唔會**產生打印任務（廚房完全唔出單 / 客人收唔到收據等）。
   *
   * 手動掣永遠優於呢啲開關：點餐介面「打印廚房單」/「打印收據」、訂單列「重打整單」、
   * 打印中心「重打整單」、交班頁「重打交班單」等**手動觸發**嘅入口唔受開關影響，
   * 開關熄咗都要照印（手動 = 用戶當下意圖，唔可以偷偷食掉，見 pos-app.tsx
   * `printKitchenTicketNow` / `printReceiptNow` / `reprintOrder`）。
   *
   * 真源同 `autoPrint` 一樣：本機 `PosLocalSettings`（store scope），唔跨店。
   */
  printContentToggles: PrintContentToggles;
  /**
   * 毛利（估）手動設定嘅「毛利率 %」。報表「毛利（估）」格子嘅 edit 掣輸入。
   * - `null`（預設）= 用系統估算（營業額 − 進貨成本）；
   * - 設咗數值（例如 50 = 50%）= 毛利估算 = 營業額 × 毛利率%。
   * 按 store scope 存落 PosLocalSettings（呢部收銀機嘅本地設定，唔跨店）。
   */
  grossProfitMarginPct?: number | null;
}

/**
 * 打印開關細粒度類型（按「**印咩內容**」分，而非「邊度觸發」分）。每個 kind 對應一個
 * toggle，false = 自動流程唔出呢種單。
 */
export type PrintContentKind =
  /** 廚房分區單（zone 機）：收銀落單／加單、線上單接單、自助單補建共用 */
  | "kitchen"
  /** 飲品標籤單（label 機）：收銀落單／加單 */
  | "label"
  /**
   * **線上訂單（Ledger／會員通）專屬閘門**：接單時出嘅廚房單／標籤單。
   *
   * 2026-09-11 新增。與 `kitchen` / `label` 係**乘積**關係：
   * 線上單出廚房單需要 `kitchen`（或 `label`）**同** `online` 同時為 true。
   *
   * 用途：Sunmi 系統本身會印線上訂單，部分店鋪唔想廚房再印一次（重複出紙）
   * → 熄呢個掣即可，唔使連累本地堂食／掃碼單嘅廚房單。
   *
   * **只**影響自動流程嘅「線上單接單」一刻（`bridgeLedgerOrderToPos` /
   * `printKitchenForLedgerOrder`）；唔影響線上單取消嘅退菜單（跟 `void`）、
   * 亦唔影響任何手動重打。
   */
  | "online"
  /** 結帳收據（receipt 機）：收銀結帳、免單、線上單完成+已付、到店付款 */
  | "receipt"
  /** 退菜／退桌單：收銀退菜、退桌、線上單取消（廚房 + 標籤機） */
  | "void"
  /** 返結單：已結單退回可編輯時出到分區機 + 標籤機 */
  | "reopen"
  /** 自助點餐機顧客小票：kiosk 落單後本機即時印嘅 1 張小票 */
  | "kiosk"
  /** 交班單：closeShift 出嘅交班明細（指定打印機） */
  | "shift";

export interface PrintContentToggles {
  kitchen: boolean;
  label: boolean;
  /** 線上訂單（Ledger／會員通）接單時出廚房單／標籤單（2026-09-11 新增，預設 true）。 */
  online: boolean;
  receipt: boolean;
  void: boolean;
  reopen: boolean;
  kiosk: boolean;
  shift: boolean;
}

export interface OrderItem {
  menuItemId: string;
  name: string;
  quantity: number;
  price: number;
  printerGroup: PrinterGroup;
  selectedSpecs?: Array<{
    groupId: string;
    groupName: string;
    optionId: string;
    optionLabel: string;
    priceDelta: number;
  }>;
  note?: string;
  /** 單品折扣：折扣百分比（0-100）。80 = 收 80 元 / 原價 100；undefined = 冇折扣。 */
  discountRate?: number;
  /** 已退菜標記（訂單明細保留記錄用，不計費、不可再操作） */
  voided?: boolean;
  /** 退菜時間（ISO） */
  voidedAt?: string;
  /** 退菜原因 */
  voidedReason?: string;
  /** 操作人帳號 */
  voidedBy?: string;
}

export interface PosOrder {
  id: string;
  /** 所屬店鋪 ID；報表 backfill 用嚴格驗證店鋪隔離。 */
  storeId?: string;
  localOrderNo: string;
  tableId: string;
  tableName: string;
  /** 開桌入座人數（開桌彈窗揀選；僅作展示／對帳用） */
  partySize?: number;
  status: "draft" | "sent_to_kitchen" | "paid" | "settled" | "reopened" | "cancelled" | "partially_refunded" | "refunded";
  fulfillmentStatus?: "preparing" | "ready";
  items: OrderItem[];
  orderNote?: string;
  subtotal: number;
  taxAmount: number;
  serviceChargeAmount: number;
  discountAmount: number;
  /**
   * 系統抹零（金額，例如 0.4）。total = subtotal - discount - rounding。
   * 收據「系統抹零」區段負值顯示；舊單（schema 升級前）冇呢個 field → 收據自動 hidden。
   * 見 docs/88。
   */
  roundingAmount?: number;
  /**
   * 顧客實際畀嘅現金（預設 = total）。結帳頁「顧客付現金」input 寫入。
   * 見 docs/88 §5.2。
   */
  cashTendered?: number;
  /**
   * 找零 = max(0, cashTendered - total)。結帳頁自動計、寫入。
   * 見 docs/88 §5.2。
   */
  changeAmount?: number;
  total: number;
  prepaidAmount?: number;
  onlineOrderId?: string;
  /**
   * 訂單來源（docs/87 §5.2 · 規格 7）。三處 UI 會顯示對應標記：訂單頁 / 收銀台快餐單卡片 / 結帳畫面。
   * - `"pos"`：員工喺收銀台落單（預設，舊單全部係呢個值）
   * - `"kiosk"`：自助點餐機（設備有 kioskDeviceBinding）
   * - `"scan"`：客人掃碼自點（QR 連結帶 `?store=` / `?tableId=`）
   */
  source?: "pos" | "kiosk" | "scan";
  paymentMethod?: PaymentMethod;
  /**
   * 免單備註（結帳頁撳「免單」時寫入，來自設置 → 備註 → 免單備註，可自由輸入）。
   *
   * ⚠️ **唔可以用 `orderNote` 裝呢個值**：`orderNote` 係「廚房備註」，受 docs/84
   * 鎖定（`isOrderNoteLocked()`：sent_to_kitchen 起鎖死），而免單一定發生喺
   * sent_to_kitchen 之後。呢度跟 `cancelledReason` / `reopenReason` 嘅既有模式，
   * 開一條**結帳期審計欄位**，喺邊個 lifecycle 階段寫就歸邊個管，兩邊唔互相污染。
   *
   * 免單語意：照出單照出收據、照計入營業額，但實收 0（全額減免）。
   */
  compNote?: string;
  /** 免單操作時間（ISO） */
  compedAt?: string;
  cancelledAt?: string;
  cancelledReason?: string;
  refundedAt?: string;
  refundedAmount?: number;
  refundedReason?: string;
  refundRecords?: Array<{
    id: string;
    amount: number;
    reason: string;
    employeeAccount?: string;
    employeeName?: string;
    items?: Array<{
      itemKey: string;
      name: string;
      quantity: number;
      amount: number;
    }>;
    createdAt: string;
  }>;

  // ── 返結（反結賬）審計欄位 ──
  /** 最近一次返結時間（ISO） */
  reopenedAt?: string;
  /** 操作人帳號（餐飲為登入員工；美容為店長） */
  reopenedBy?: string;
  /** 返結原因（來自設置 reopenReasons 或自填） */
  reopenReason?: string;
  /** 累計返結次數 */
  reopenCount?: number;
  /** 首次結帳（settled）時間，重結後保留以便對帳 */
  originalSettledAt?: string;
  // ── 結帳審計（訂單明細「收銀員」欄位用）──
  /** 結帳操作人帳號（confirmPayment / settleCompOrder / completeOnlinePaidOrder / markOrderCompleted 寫入；舊單冇 → 顯示「未記錄」） */
  settledBy?: string;
  /** 結帳操作人顯示名（優先顯示；同 settledBy 一齊寫入） */
  settledByName?: string;
  /** 返結時原枱 id（temp 枱結帳後還原用） */
  reopenOriginalTableId?: string;
  /** 返結時原枱名（temp 枱結帳後還原用） */
  reopenOriginalTableName?: string;

  // ── 返結會員扣款快照（供反向回滾 / 重結用）──
  /** 上次結帳透過會員餘額扣減的 avos（不含券），供返結反向回滾 */
  memberDeductionAvos?: number;
  /** 上次結帳扣款的會員電話（Ledger phone），供返結反向回滾 */
  ledgerMemberPhone?: string;

  // ── 出餐時間儀器化（Phase B，模塊 4）──
  /** 首次送入廚房時間（ISO）。出餐時間 = servedAt − sentToKitchenAt。 */
  sentToKitchenAt?: string;
  /** 出餐（交到客人手上）時間（ISO）。堂食＝結帳 settled；快餐 counter＝標記 ready（可取餐／交付）。 */
  servedAt?: string;

  createdAt: string;
  updatedAt: string;
  /** 已退菜明細（保留記錄，不計費；結帳 / 退菜後仍留在單上以便追蹤） */
  voidedItems?: OrderItem[];
}

export type OnlinePaymentStatus = "paid" | "unpaid";

/**
 * 推唔到嘅事件點解推唔到（配合 status:"skipped"）。
 *
 * - `foreign-store` / `no-store`：無法證明歸屬當前店（見 docs/111 §D）。
 * - `user-discarded`：用戶喺同步健康面板主動放棄。
 * - `server-newer`（2026-09-10 docs/112）：server 回執明講「我手上有更新版本」
 *   （`applied:false, reason:"stale"|"downgrade"`）。**重推同一條事件係冇意義**，
 *   所以唔可以當 pending 一直燒 attempts，要落 skipped 終態；補救由對賬守護
 *   用「本機終態完整快照」重新入隊一條新事件（見 sync-reconcile-daemon.ts）。
 */
export type QueueSkipReason = "foreign-store" | "no-store" | "user-discarded" | "server-newer";

export interface QueueEvent {
  id: string;
  type: QueueEventType;
  entityId: string;
  payload: unknown;
  /**
   * - `pending`：排隊等推（outbox 語義：queue 入面淨係未上雲嘅工作）
   * - `synced`：已上雲（v1 墓碑；v2 outbox 模式成功後係直接剷走，唔會留呢個狀態）
   * - `failed`：server 連續拒收 MAX_SYNC_ATTEMPTS 次，永久失敗，等人手處理
   * - `skipped`：**終態**，推唔到但有明確原因（見 {@link QueueSkipReason}）。
   *   冇呢個狀態之前，外店 / 無 storeId 嘅事件會一世留喺 pending，令交班畫面
   *   永遠顯示「N 筆未同步」（假陽性）。見 docs/111。
   */
  status: "pending" | "synced" | "failed" | "skipped";
  createdAt: string;
  /** 已嘗試推送次數（sync-flush 用；超過 MAX_SYNC_ATTEMPTS 標 failed）。 */
  attempts?: number;
  /** 最近一次推送失敗嘅原因（server HTTP status / body 節錄）。failed 事件診斷用。 */
  lastError?: string;
  /** 最近一次被標 failed 嘅時間（ISO）。同步健康檢查排序用。 */
  lastFailedAt?: string;
  /** 淨係 status === "skipped" 時有意義：點解呢條事件唔會被推送。 */
  skipReason?: QueueSkipReason;
  /**
   * 事件所屬店舖（= 事件產生嗰刻 `resolveStoreId()`：登入 merchant 或 kiosk 綁定店）。
   *
   * 跨店隔離（0022 migration）嘅真源：flush 只推 `storeId === 當前店` 嘅事件、
   * `/api/pos/state` 按 store 過濾 queue、`/api/pos/sync` 驗證 event.storeId 與
   * 請求 storeId 一致。**入隊時由 `withStoreScope()` stamp，已有值絕對唔覆寫**
   * （防止外店事件被「改姓」）。歷史 legacy 事件可能冇呢個欄（undefined）→
   * flush 閘口會跳過佢哋（無法證明歸屬，推咗就係跨店污染）。
   */
  storeId?: string;
}

export interface PrintJob {
  id: string;
  orderId: string;
  orderNo?: string;
  tableName?: string;
  ticketType: "normal" | "addon" | "void";
  printerGroup: PrinterGroup;
  printerId?: string;
  printerName: string;
  /** 要打印嘅菜品行（扁平後嘅 {@link PrintItemLine}）。可選 — 標籤單未必有 items。 */
  items?: Array<{
    name: string;
    quantity: number;
    /** 收據主行額外印單項小計（quantity × 基價）。companion / android renderer 識嘅就會印，唔識就忽略（out-of-scope 唔影響主行）。POS preview EscPosPreview 已 render。 */
    price?: number;
    specs?: string[];
    note?: string;
    /** 單品折扣百分比（0-100）；缺省 = 冇折扣。escpos-render.ts → PrintItemLine。 */
    discountRate?: number;
    /** 單件原價（未扣 spec delta、未套 discountRate）。同上源。 */
    originalUnitPrice?: number;
    /** 折後單價（已套 discountRate）。 */
    discountedUnitPrice?: number;
    /** 折讓 = (base − discounted) × quantity；0 = 冇折讓唔顯示。 */
    savingAmount?: number;
  }>;
  status: "pending" | "sent" | "failed" | "printed";
  /**
   * 最近一次派發失敗嘅原因（嚟自 `dispatchOneJob()` 嘅 error）。
   *
   * 冇咗呢個欄位，打印中心淨係見到「失敗」兩個字，完全唔知衰邊度 ——
   * 同 Print Hub 最初報嗰個 bug 同一個病：`dispatch.ts` 其實咁辛苦整咗句原因出嚟，
   * 但寫落 job 嗰陣掉咗，根本冇傳到 UI。
   *
   * 由 `dispatch.ts` 負責寫同清：失敗寫低，成功／轉 pending 重試時清走。
   */
  lastError?: string;
  createdAt: string;
  /** 雙路徑：所屬店 ID（relay 路由用；LAN 直打可由終端補） */
  storeId?: string;
  /** 雙路徑：job 過期時間（epoch millis）；relay 丟棄過期 job，POS 側超時轉 fallback */
  ttl?: number;
  /** 商家 ESC/POS 模板快照（自包含、可序列化）；renderer 強制套用，缺位 fallback 舊格式 */
  template?: EscPosTemplateSnapshot;
  /** 靜態區塊文字（key = section id），renderer 按 block.style 印；items / qr_code 區塊除外 */
  content?: Record<string, string>;
  /**
   * 收據二維碼目標網址（由 `ReceiptTemplate.qrUrl` 帶過嚟）。純參考 / 除錯用；
   * renderer 實際打印係靠下面嘅 `qr` 點陣。空白 → 唔印。
   */
  qrUrl?: string;
  /**
   * 收據二維碼點陣（POS 端 `encodeQrPayload()` 預先編好）。
   *
   * 三個 repo 共用同一個矩陣 → 唔使各自實作 QR encoder，亦保證出紙同預覽 100% 一樣。
   * renderer 用 ESC/POS 點陣圖指令（`GS v 0`）輸出，相容性高過 `GS ( k` 原生 QR 指令。
   * 冇呢個欄位（網址空白 / 太長編唔到）→ `qr_code` 區塊直接略過。
   */
  qr?: QrPayload;
  /**
   * 呢張單要印幾份。落單端寫死，優先於打印機層級嘅 `DevicePrinterConfig.copies`。
   *
   * 點解要 job 層面：份數而家係**跟打印機**唔係跟訂單（`dispatch.ts` 讀 `printer.copies`），
   * 若廚房機設咗 2 份而自助點餐用同一部機，就會印 2 份。
   * 自助點餐單固定 1 張（規格），所以一定要喺 job 帶 `copies: 1` 落去。見 docs/87 §6.1。
   */
  copies?: number;
}

// ── 跨平台雙路徑打印：統一傳輸層合約（Phase 0 骨架） ──
//
// 三個平台各自實作一套 Transport（Android=Kotlin Socket/UsbManager/BluetoothSocket；
// desktop=Node/Rust net+node-usb+COM；iOS=Swift Network.framework/BLE·MFi），
// POS 網頁只靠呢個介面溝通，唔使知底層 OS 差異。見 docs/43。

/** 派發通道用嘅票種。label 原本長期缺位，搞到杯標籤被當 kitchen 出單（印咗「＊＊＊ 廚房 ＊＊＊」抬頭）。 */
/**
 * 經打印通道（Companion / relay）發送時嘅單據類型。
 *
 * `"shift"`（2026-09-10 加）：交班結算單。三個通道嘅渲染器一律「有
 * `job.template` 快照就行模板路徑、`kind` 淨係用嚟決定抬頭」——
 * 下游唔識 `"shift"` 嘅話抬頭會 fall through 去空字串（唔會印錯），
 * 交班單嘅抬頭由模板 `header` 區塊自己帶。所以呢個值加落嚟係安全嘅。
 */
export type PrintKind = "receipt" | "kitchen" | "label" | "shift" | "test";

export interface PrintSendOptions {
  kind: PrintKind;
  storeName?: string;
  paymentMethod?: string;
  total?: number;
}

export interface PrintSendResult {
  ok: boolean;
  /** 已 queue 但未出單（終端 local agent 接受咗） */
  queued?: boolean;
  error?: string;
  /** 錯誤碼（同 window.__posNativePrintResult 嘅 code，見 docs/45 §5） */
  code?: string;
  /** 非同步結果會經 native bridge / relay 回傳呢個 id（對應 PrintJob.id） */
  ticketId?: string;
}

/** 統一列印傳輸層。LanTransport（path A）/ RelayTransport（path B）都實作佢。 */
export interface PrintTransport {
  /** 呢個 transport 能否處理某部打印機（按 connectionType） */
  supports(printer: DevicePrinterConfig): boolean;
  /** 發送一個 job；resolve 表示「已 queue / 已送出」，唔等物理出單 */
  send(job: PrintJob, printer: DevicePrinterConfig, opts: PrintSendOptions): Promise<PrintSendResult>;
  /** 可選：探測打印機 availability（LAN socket / USB 列舉 / BT 配對） */
  probe?(printer: DevicePrinterConfig): Promise<boolean>;
}
