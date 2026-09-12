import {
  BackofficeSyncJob,
  AccountPermissionGroup,
  AccountStore,
  AccountUser,
  PosBootstrap,
  DEFAULT_LABEL_PAPER_ID,
  DeviceConfig,
  PosLocalSettings,
} from "@/lib/types";
import {
  DEFAULT_SHIFT_TEMPLATE,
  DEFAULT_SHIFT_TEMPLATE_PRESETS,
  DEFAULT_SHIFT_TEMPLATE_PRESET_ID,
} from "@/lib/escpos-template";

export const defaultAccountStores: AccountStore[] = [
  {
    id: "macau-store-a",
    name: "澳門店 A",
    active: true,
    code: "MO-A01",
    city: "澳門",
    sourceStoreId: "main-store-001",
    sourceActive: true,
    manualDeactivated: false,
    effectiveActive: true,
    syncStatus: "ok",
    lastSyncedAt: "2026-08-08T08:30:00.000Z",
    lastHeartbeatAt: "2026-08-08T08:28:00.000Z",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    note: "預設主門店。",
  },
  {
    id: "macau-store-b",
    name: "澳門店 B",
    active: true,
    code: "MO-B02",
    city: "澳門",
    sourceStoreId: "main-store-002",
    sourceActive: true,
    manualDeactivated: false,
    effectiveActive: true,
    syncStatus: "pending",
    lastSyncedAt: "2026-08-08T07:50:00.000Z",
    lastHeartbeatAt: "2026-08-08T07:20:00.000Z",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    note: "分店示例。",
  },
];

export const defaultPermissionGroups: AccountPermissionGroup[] = [
  {
    id: "perm-admin",
    code: "admin-full",
    name: "管理員全權",
    role: "admin",
    permissions: { refundOrder: true, voidItem: true, manageAccounts: true },
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    note: "可管理帳戶、退款、退菜。",
  },
  {
    id: "perm-manager",
    code: "store-manager",
    name: "店長權限",
    role: "manager",
    permissions: { refundOrder: true, voidItem: true, manageAccounts: false },
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    note: "可退款、退菜，不可管理帳戶。",
  },
  {
    id: "perm-cashier",
    code: "cashier-basic",
    name: "收銀權限",
    role: "cashier",
    permissions: { refundOrder: false, voidItem: false, manageAccounts: false },
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    note: "基本收銀權限。",
  },
];

export const defaultAccountUsers: AccountUser[] = [
  {
    id: "acct-admin-1",
    account: "60000000",
    pin: "0000",
    name: "系統管理員",
    role: "admin",
    active: true,
    sourceAccountId: "main-account-001",
    sourceActive: true,
    manualDeactivated: false,
    effectiveActive: true,
    lastSyncedAt: "2026-08-08T08:30:00.000Z",
    storeIds: ["macau-store-a", "macau-store-b"],
    permissionGroupId: "perm-admin",
    permissions: {
      refundOrder: true,
      voidItem: true,
      manageAccounts: true,
    },
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    note: "總管理帳戶，可管理所有帳戶狀態。",
  },
  {
    id: "acct-manager-1",
    account: "63936541",
    pin: "1234",
    name: "店長",
    role: "manager",
    active: true,
    sourceAccountId: "main-account-101",
    sourceActive: true,
    manualDeactivated: false,
    effectiveActive: true,
    lastSyncedAt: "2026-08-08T08:25:00.000Z",
    storeIds: ["macau-store-a"],
    permissionGroupId: "perm-manager",
    permissions: {
      refundOrder: true,
      voidItem: true,
      manageAccounts: false,
    },
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    note: "門店管理帳戶。",
  },
  {
    id: "acct-cashier-1",
    account: "63936542",
    pin: "1234",
    name: "收銀員",
    role: "cashier",
    active: true,
    sourceAccountId: "main-account-201",
    sourceActive: true,
    manualDeactivated: false,
    effectiveActive: true,
    lastSyncedAt: "2026-08-08T08:25:00.000Z",
    storeIds: ["macau-store-a"],
    permissionGroupId: "perm-cashier",
    permissions: {
      refundOrder: false,
      voidItem: false,
      manageAccounts: false,
    },
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    note: "前台收銀帳戶。",
  },
];

export const defaultBackofficeSyncJobs: BackofficeSyncJob[] = [
  {
    id: "sync-full-001",
    jobType: "full",
    scope: "全部店舖",
    status: "success",
    startedAt: "2026-08-08T08:20:00.000Z",
    finishedAt: "2026-08-08T08:22:00.000Z",
    pulledCount: 18,
    upsertedCount: 18,
    failedCount: 0,
    summary: "主系統主檔同步完成，stores / accounts / bindings 已更新。",
  },
  {
    id: "sync-stores-002",
    jobType: "stores",
    scope: "澳門區門店",
    status: "running",
    startedAt: "2026-08-08T08:40:00.000Z",
    pulledCount: 2,
    upsertedCount: 1,
    failedCount: 0,
    summary: "門店同步進行中，等待主系統回傳剩餘門店資料。",
  },
  {
    id: "sync-accounts-003",
    jobType: "accounts",
    scope: "全部帳戶",
    status: "failed",
    startedAt: "2026-08-08T07:15:00.000Z",
    finishedAt: "2026-08-08T07:16:00.000Z",
    pulledCount: 12,
    upsertedCount: 10,
    failedCount: 2,
    summary: "帳戶同步中斷，有 2 筆資料格式不符合預期。",
    error: "主系統回傳的 permission_group_code 缺失。",
  },
];

export const mockBootstrap: PosBootstrap = {
  sourceVersion: 1,
  storeId: "macau-store-a",
  storeName: "澳門店 A",
  // 店家電話（收據抬頭，仿 57.doc「電話：xxx」一欄）。
  //
  // ⚠️ 刻意**唔填**：mock bootstrap 係 fallback，呢度一填就會永遠壓住
  // `resolveStoreTel()` 嘅「商家登入號碼」fallback，搞到所有舖都印同一個假號碼。
  // 收據電話嘅單一真源係 `src/lib/pos/store-tel.ts`：
  //   bootstrap.storeTel（將來 `pos_stores.tel`）→ 商家登入號碼 → 唔顯示。
  currency: "MOP",
  categories: [
    { id: "cat-rice", name: "飯類" },
    { id: "cat-noodle", name: "粉麵" },
    { id: "cat-drink", name: "飲品" },
  ],
  menuItems: [
    {
      id: "item-bbq-rice",
      categoryId: "cat-rice",
      name: "叉燒飯",
      price: 48,
      printerGroup: "kitchen",
    },
    {
      id: "item-beef-noodle",
      categoryId: "cat-noodle",
      name: "牛腩麵",
      price: 52,
      printerGroup: "kitchen",
    },
    {
      id: "item-fish-pot",
      categoryId: "cat-rice",
      name: "酸菜魚",
      price: 138,
      printerGroup: "kitchen",
      specGroups: [
        {
          id: "spice",
          name: "辣度",
          selectionMode: "single",
          required: true,
          options: [
            { id: "mild", label: "小辣", priceDelta: 0 },
            { id: "medium", label: "中辣", priceDelta: 0 },
            { id: "hot", label: "大辣", priceDelta: 0 },
          ],
        },
        {
          id: "size",
          name: "份量",
          selectionMode: "single",
          required: true,
          options: [
            { id: "small", label: "小份", priceDelta: 0 },
            { id: "large", label: "大份", priceDelta: 20 },
          ],
        },
        {
          id: "addon",
          name: "配菜",
          selectionMode: "multi",
          required: false,
          options: [
            { id: "regular", label: "標準", priceDelta: 0 },
            { id: "tofu", label: "加豆腐", priceDelta: 8 },
            { id: "vermicelli", label: "加粉絲", priceDelta: 10 },
          ],
        },
      ],
    },
    {
      id: "item-toast",
      categoryId: "cat-rice",
      name: "餐蛋治",
      price: 28,
      printerGroup: "kitchen",
    },
    {
      id: "item-lemon-tea",
      categoryId: "cat-drink",
      name: "凍檸茶",
      price: 18,
      printerGroup: "drinks",
    },
    {
      id: "item-milk-tea",
      categoryId: "cat-drink",
      name: "凍奶茶",
      price: 20,
      printerGroup: "drinks",
    },
  ],
  tables: [
    { id: "table-a01", name: "A01", area: "1樓", floorId: "floor-1" },
    { id: "table-a02", name: "A02", area: "1樓", floorId: "floor-1" },
    { id: "table-b01", name: "B01", area: "1樓", floorId: "floor-1" },
    { id: "table-b02", name: "B02", area: "2樓", floorId: "floor-2" },
  ],
  rules: {
    orderFlow: "send_then_pay",
    allowSplitBill: false,
    allowMemberLookup: false,
    taxRate: 0,
    serviceChargeRate: 0,
    paymentMethods: ["cash", "card", "mpay"],
  },
  printerGroups: ["kitchen", "drinks", "receipt"],
  lastUpdatedAt: "2026-08-04T00:00:00.000Z",
};

// ⚠️ 2026-09-09 修：printers 改為空陣列。舊版呢度寫死 4 台 mock 打印機
// （廚房/吧台/收據/標籤，IP 全係假），令全新 iPad 未 save 過任何設定、
// DB pos_device_configs 完全無 row 嘅情況下，設置頁同打印流程都會見到
// 4 台「幽靈打印機」。預期行為：無保存記錄 → 列表留空，由用家自己添加。
// 所有 `loadDeviceConfig() ?? defaultDeviceConfig` fallback 點自動跟住變空。
export const defaultDeviceConfig: DeviceConfig = {
  deviceId: "tablet-01",
  terminalName: "收銀機 01",
  storeId: "macau-store-a",
  updatedAt: "2026-08-04T00:00:00.000Z",
  printers: [],
};

export const defaultPosLocalSettings: PosLocalSettings = {
  floors: [
    {
      id: "floor-1",
      name: "1樓",
      tables: [
        { id: "table-a01", name: "A01", area: "1樓", floorId: "floor-1" },
        { id: "table-a02", name: "A02", area: "1樓", floorId: "floor-1" },
        { id: "table-a03", name: "A03", area: "1樓", floorId: "floor-1" },
      ],
    },
    {
      id: "floor-2",
      name: "2樓",
      tables: [
        { id: "table-b01", name: "B01", area: "2樓", floorId: "floor-2" },
        { id: "table-b02", name: "B02", area: "2樓", floorId: "floor-2" },
      ],
    },
  ],
  paymentMethods: ["現金", "Mpay", "中銀"],
  menuPrinterOverrides: {
    "item-bbq-rice": "kitchen",
    "item-beef-noodle": "kitchen",
    "item-fish-pot": "kitchen",
    "item-toast": "kitchen",
    "item-lemon-tea": "drinks",
    "item-milk-tea": "drinks",
  },
  printZones: [
    { id: "kitchen", name: "廚房" },
    { id: "drinks", name: "水吧" },
  ],
  specTemplates: [
    {
      id: "tpl-drink-default",
      name: "飲品通用規格",
      specGroups: [
        {
          id: "drink-size",
          name: "杯型",
          selectionMode: "single",
          required: true,
          options: [
            { id: "regular", label: "標準", priceDelta: 0 },
            { id: "large", label: "大杯", priceDelta: 2 },
          ],
        },
        {
          id: "drink-ice",
          name: "冰量",
          selectionMode: "single",
          required: true,
          options: [
            { id: "normal-ice", label: "正常冰", priceDelta: 0 },
            { id: "less-ice", label: "少冰", priceDelta: 0 },
            { id: "no-ice", label: "走冰", priceDelta: 0 },
          ],
        },
        {
          id: "drink-sugar",
          name: "甜度",
          selectionMode: "single",
          required: true,
          options: [
            { id: "full-sugar", label: "正常甜", priceDelta: 0 },
            { id: "half-sugar", label: "半糖", priceDelta: 0 },
            { id: "less-sugar", label: "少甜", priceDelta: 0 },
            { id: "no-sugar", label: "走甜", priceDelta: 0 },
          ],
        },
      ],
    },
  ],
  standaloneSpecGroups: [],
  printTemplates: {
    receipt: {
      blocks: {
        store_name: { visible: true, size: "m", bold: true, align: "center" },
        store_tel: { visible: true, size: "s", bold: false, align: "center" },
        order_no: { visible: true, size: "s", bold: false, align: "left" },
        table_name: { visible: true, size: "s", bold: false, align: "left" },
        order_time: { visible: true, size: "s", bold: false, align: "left" },
        checkout_time: { visible: true, size: "s", bold: false, align: "left" },
        server: { visible: false, size: "s", bold: false, align: "left" },
        divider: { visible: true, size: "s", bold: false, align: "left" },
        items: { visible: true, size: "m", bold: true, align: "left" },
        discount_breakdown: { visible: true, size: "s", bold: false, align: "left" },
        subtotal_before_discount: { visible: true, size: "s", bold: false, align: "right" },
        service_charge_amount: { visible: true, size: "s", bold: false, align: "right" },
        tax_amount: { visible: true, size: "s", bold: false, align: "right" },
        rounding_amount: { visible: true, size: "s", bold: false, align: "right" },
        discount_amount: { visible: true, size: "s", bold: false, align: "right" },
        total: { visible: true, size: "l", bold: true, align: "right" },
        cash_tendered: { visible: true, size: "s", bold: false, align: "right" },
        change_amount: { visible: true, size: "s", bold: false, align: "right" },
        payment_method: { visible: true, size: "s", bold: false, align: "left" },
        // 零售新增（2026-09-13）：全部係靜態文字區塊，內容空白時 renderer 自動略過 →
        // 餐飲 / 自助機單完全唔受影響。加下游三端唔使改（見 ReceiptSectionId 註釋）。
        split_payment: { visible: true, size: "s", bold: false, align: "left" },
        points_earned: { visible: true, size: "s", bold: false, align: "left" },
        exchange_of: { visible: true, size: "s", bold: false, align: "left" },
        return_policy: { visible: true, size: "s", bold: false, align: "left" },
        order_note: { visible: true, size: "s", bold: false, align: "left" },
        qr_code: { visible: true, size: "s", bold: false, align: "center" },
        footer: { visible: true, size: "s", bold: false, align: "center" },
      },
      order: ["store_name", "store_tel", "order_no", "exchange_of", "table_name", "order_time", "checkout_time", "server", "divider", "items", "discount_breakdown", "subtotal_before_discount", "service_charge_amount", "tax_amount", "rounding_amount", "discount_amount", "total", "cash_tendered", "change_amount", "payment_method", "split_payment", "points_earned", "order_note", "return_policy", "qr_code", "footer"],
      footerText: "多謝惠顧，歡迎再次光臨",
    },
    label: {
      blocks: {
        header: { visible: true, size: "m", bold: true, align: "center" },
        item_name: { visible: true, size: "l", bold: true, align: "left" },
        temperature: { visible: true, size: "s", bold: false, align: "center" },
        cup_type: { visible: true, size: "s", bold: false, align: "center" },
        sugar: { visible: true, size: "s", bold: false, align: "center" },
        ice: { visible: true, size: "s", bold: false, align: "center" },
        sugar_tag: { visible: true, size: "s", bold: true, align: "center" },
        ice_tag: { visible: true, size: "s", bold: true, align: "center" },
        addons: { visible: true, size: "s", bold: false, align: "left" },
        specs: { visible: true, size: "s", bold: false, align: "left" },
        item_note: { visible: true, size: "s", bold: false, align: "left" },
        order_no: { visible: true, size: "s", bold: false, align: "center" },
        footer: { visible: true, size: "s", bold: false, align: "center" },
      },
      order: ["header", "item_name", "temperature", "cup_type", "sugar", "ice", "sugar_tag", "ice_tag", "addons", "specs", "item_note", "order_no", "footer"],
      headerText: "飲品標籤",
      footerText: "請盡快出品",
      paperSize: DEFAULT_LABEL_PAPER_ID,
    },
    kitchen: {
      blocks: {
        store_name: { visible: true, size: "m", bold: true, align: "center" },
        order_no: { visible: true, size: "s", bold: false, align: "left" },
        table_name: { visible: true, size: "s", bold: false, align: "left" },
        order_type: { visible: true, size: "s", bold: true, align: "left" },
        time: { visible: true, size: "s", bold: false, align: "left" },
        divider: { visible: true, size: "s", bold: false, align: "left" },
        items: { visible: true, size: "m", bold: true, align: "left" },
        order_note: { visible: true, size: "s", bold: false, align: "left" },
        footer: { visible: true, size: "s", bold: false, align: "center" },
      },
      order: ["store_name", "order_no", "table_name", "order_type", "time", "divider", "items", "order_note", "footer"],
      headerText: "",
      footerText: "廚房留底",
    },
    // 自助點餐機模版（第四個槽位）：預設內容同收據一致（規格 8）。
    // 商家可喺「打印」頁第四個分頁自行改，唔影響收銀台收據。
    kiosk: {
      blocks: {
        store_name: { visible: true, size: "m", bold: true, align: "center" },
        store_tel: { visible: true, size: "s", bold: false, align: "center" },
        order_no: { visible: true, size: "s", bold: false, align: "left" },
        table_name: { visible: true, size: "s", bold: false, align: "left" },
        order_time: { visible: true, size: "s", bold: false, align: "left" },
        checkout_time: { visible: false, size: "s", bold: false, align: "left" },
        server: { visible: false, size: "s", bold: false, align: "left" },
        divider: { visible: true, size: "s", bold: false, align: "left" },
        items: { visible: true, size: "m", bold: true, align: "left" },
        discount_breakdown: { visible: true, size: "s", bold: false, align: "left" },
        subtotal_before_discount: { visible: true, size: "s", bold: false, align: "right" },
        service_charge_amount: { visible: true, size: "s", bold: false, align: "right" },
        tax_amount: { visible: true, size: "s", bold: false, align: "right" },
        rounding_amount: { visible: true, size: "s", bold: false, align: "right" },
        discount_amount: { visible: true, size: "s", bold: false, align: "right" },
        total: { visible: true, size: "l", bold: true, align: "right" },
        cash_tendered: { visible: true, size: "s", bold: false, align: "right" },
        change_amount: { visible: true, size: "s", bold: false, align: "right" },
        payment_method: { visible: true, size: "s", bold: false, align: "left" },
        // 零售新增（2026-09-13）：全部係靜態文字區塊，內容空白時 renderer 自動略過 →
        // 餐飲 / 自助機單完全唔受影響。加下游三端唔使改（見 ReceiptSectionId 註釋）。
        split_payment: { visible: true, size: "s", bold: false, align: "left" },
        points_earned: { visible: true, size: "s", bold: false, align: "left" },
        exchange_of: { visible: true, size: "s", bold: false, align: "left" },
        return_policy: { visible: true, size: "s", bold: false, align: "left" },
        order_note: { visible: true, size: "s", bold: false, align: "left" },
        qr_code: { visible: true, size: "s", bold: false, align: "center" },
        footer: { visible: true, size: "s", bold: false, align: "center" },
      },
      order: ["store_name", "store_tel", "order_no", "exchange_of", "table_name", "order_time", "checkout_time", "server", "divider", "items", "discount_breakdown", "subtotal_before_discount", "service_charge_amount", "tax_amount", "rounding_amount", "discount_amount", "total", "cash_tendered", "change_amount", "payment_method", "split_payment", "points_earned", "order_note", "return_policy", "qr_code", "footer"],
      footerText: "多謝惠顧，歡迎再次光臨",
    },
    // 交班結算單模板（第五個槽位，2026-09-10）。直接引用 escpos-template 嘅出廠預設，
    // 唔喺度再抄一次 30 個區塊 —— 兩邊各寫一份必然會走樣（storage normalize 亦用同一份）。
    shift: DEFAULT_SHIFT_TEMPLATE,
  },
  // 交班模板範本庫（商家可新增 / 改名 / 刪除 / 套用）+ 上次套用嘅範本 id。
  // 出廠有一套「標準交班單」，令商家一入頁就見到「範本」係咩概念。
  shiftTemplatePresets: DEFAULT_SHIFT_TEMPLATE_PRESETS,
  activeShiftTemplateId: DEFAULT_SHIFT_TEMPLATE_PRESET_ID,
  notePresets: ["多飯", "少飯", "小冰", "少冰", "走冰", "少甜", "走甜", "走蔥", "走辣"],
  cancelNotePresets: ["客人取消", "售罄", "下錯單", "重開一單"],
  // 免單備註：結帳頁撳「免單」時要揀嘅原因（設置 → 備註 → 免單備註 可增刪）
  compNotePresets: ["老闆請客", "員工餐", "客人投訴補償", "試食推廣", "熟客優惠"],
  // 折扣備註：結帳頁揀「全單折扣」或改「單品折扣」時要揀嘅原因（設置 → 備註 → 折扣備註 可增刪）。
  // 有別於免單備註：折扣係「收少啲但照收錢」，原因要落報表 / 交班明細。
  discountNotePresets: ["員工優惠", "會員折扣", "熟客優惠", "假日推廣", "補償客人"],
  discounts: [
    { id: "disc-90", label: "9折", rate: 90 },
    { id: "disc-85", label: "85折", rate: 85 },
    { id: "disc-80", label: "8折", rate: 80 },
    { id: "disc-50", label: "5折", rate: 50 },
  ],
  reopenReasons: ["結帳錯誤", "加錯項目", "折扣計錯", "找錯錢", "會員扣錯", "客人要求改單"],
  fullVoidBehavior: "cancelled",
  onlineOrderSettings: {
    autoAccept: false,
  },
  // 「自動接自助單」開關（取代 kioskKitchenMode）。true = 免確認直接出單（規格 5 嘅預設）。
  autoAcceptSelfOrder: true,
  // 「自動打印」開關：預設開（落單出廚房單、結帳出收據）。見 PosLocalSettings.autoPrint。
  autoPrint: true,
  // 細粒度打印開關：每個類型預設全開。商家可喺設備設置 → 打印開關設置逐項關閉。
  // 見 PosLocalSettings.printContentToggles。
  printContentToggles: {
    kitchen: true,
    label: true,
    // 線上訂單接單時出廚房單／標籤單。預設 true：Sunmi 系統會自己印線上單，
    // 唔想廚房重複出紙嘅店鋪可去設備設置 → 打印開關設置熄佢。
    online: true,
    receipt: true,
    void: true,
    reopen: true,
    kiosk: true,
    shift: true,
  },
  // 毛利（估）手動設定毛利率 %：預設 null = 用系統估算。見 PosLocalSettings.grossProfitMarginPct。
  grossProfitMarginPct: null,

  // ── 零售（2026-09-12）──────────────────────────────────────────
  // 全部預設空 → 零售商戶第一次入設定頁自己建。
  // ⚠️ 餐飲 / 沙龍商戶永遠唔會見到（`/retail/*` 係獨立分支），所以空預設零影響。
  scannerProfiles: [],
  activeScannerProfileId: "",
  weighedBarcodeRules: [],
  retailPaymentMethods: [],
  customLabelPapers: [],
  // 改價一律要閘；低於 9 折或單品優惠 > $50 要主管授權。
  retailApprovalRules: { minDiscountRate: 90, maxLineSaving: 50 },
};
