import { PosBootstrap, DeviceConfig, PosLocalSettings, MemberProfile } from "@/lib/types";

export const mockBootstrap: PosBootstrap = {
  sourceVersion: 1,
  storeId: "macau-store-a",
  storeName: "澳門店 A",
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

export const defaultDeviceConfig: DeviceConfig = {
  deviceId: "tablet-01",
  terminalName: "收銀機 01",
  storeId: "macau-store-a",
  updatedAt: "2026-08-04T00:00:00.000Z",
  printers: [
    {
      id: "printer-kitchen-1",
      group: "kitchen",
      connectionType: "lan",
      name: "廚房打印機",
      ipAddress: "192.168.1.110",
      enabled: true,
    },
    {
      id: "printer-drinks-1",
      group: "drinks",
      connectionType: "lan",
      name: "吧台打印機",
      ipAddress: "192.168.1.111",
      enabled: true,
    },
    {
      id: "printer-receipt-1",
      group: "receipt",
      connectionType: "usb",
      name: "收據打印機",
      usbLabel: "USB-Receipt-01",
      enabled: true,
    },
  ],
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
  notePresets: ["多飯", "少飯", "小冰", "少冰", "走冰", "少甜", "走甜", "走蔥", "走辣"],
  onlineOrderSettings: {
    autoAccept: false,
  },
};

export const defaultMembers: MemberProfile[] = [
  {
    id: "mem-001",
    name: "陳小明",
    phone: "66112233",
    balance: 320,
    level: "金卡",
    coupons: [
      {
        id: "cp-001",
        title: "滿100減20",
        type: "amount_off",
        amountOff: 20,
        minSpend: 100,
        stackable: false,
        expiresAt: "2026-12-31T23:59:59.000Z",
      },
      {
        id: "cp-002",
        title: "95折（最多減30）",
        type: "percent_off",
        percentOff: 5,
        maxOff: 30,
        minSpend: 50,
        stackable: false,
        expiresAt: "2026-12-31T23:59:59.000Z",
      },
    ],
  },
  {
    id: "mem-002",
    name: "李小姐",
    phone: "66334455",
    balance: 58,
    level: "銀卡",
    coupons: [
      {
        id: "cp-010",
        title: "滿50減10",
        type: "amount_off",
        amountOff: 10,
        minSpend: 50,
        stackable: true,
        expiresAt: "2026-12-31T23:59:59.000Z",
      },
      {
        id: "cp-011",
        title: "飲品券 -10",
        type: "amount_off",
        amountOff: 10,
        minSpend: 0,
        stackable: true,
        expiresAt: "2026-12-31T23:59:59.000Z",
      },
    ],
  },
  {
    id: "mem-003",
    name: "黃先生",
    phone: "66778899",
    balance: 0,
    level: "普通",
    coupons: [
      {
        id: "cp-020",
        title: "滿80減15",
        type: "amount_off",
        amountOff: 15,
        minSpend: 80,
        stackable: false,
        expiresAt: "2026-12-31T23:59:59.000Z",
      },
    ],
  },
];
