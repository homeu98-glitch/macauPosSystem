import { PosBootstrap, DeviceConfig, PosLocalSettings } from "@/lib/types";

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
};
