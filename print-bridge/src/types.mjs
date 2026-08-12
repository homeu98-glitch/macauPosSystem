/**
 * @typedef {Object} BridgePrintJob
 * @property {string} id
 * @property {string} orderId
 * @property {string} [orderNo]
 * @property {string} [tableName]
 * @property {'normal'|'addon'|'void'} ticketType
 * @property {string} printerGroup
 * @property {string} printerName
 * @property {string} [printerId]
 * @property {Array<{ name: string, quantity: number, specs?: string[], note?: string }>} [items]
 * @property {'pending'|'sent'|'failed'} status
 * @property {string} createdAt
 */

/**
 * @typedef {Object} BridgePrinter
 * @property {string} id
 * @property {'zone'|'receipt'|'label'} role
 * @property {string} [zoneId]
 * @property {'lan'|'usb'} connectionType
 * @property {string} name
 * @property {string} [model]
 * @property {string} [paperSize]
 * @property {string} [ipAddress]
 * @property {number} [lanPort]
 * @property {string} [usbLabel]
 * @property {boolean} enabled
 */

/**
 * @typedef {Object} BridgeDeviceConfig
 * @property {string} deviceId
 * @property {string} terminalName
 * @property {string} storeId
 * @property {BridgePrinter[]} printers
 * @property {string} updatedAt
 */

export {};
