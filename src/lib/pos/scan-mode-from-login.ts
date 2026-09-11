import type { ScanMode } from "./kiosk-settings";

/**
 * 登入模式 → 店級掃碼點餐模式（docs/115 §12，2026-09-10 改為**登入驅動**）。
 *
 * ## 為什麼由登入決定，而不是設定頁揀
 *
 * 商家嘅心智模型係「我開嘅係快餐店定堂食店」，佢喺**登入嗰刻已經揀咗**。
 * 之前要佢登入完再入設定頁揀多次 = 同一個問題問兩次，而且兩邊可以唔一致
 * （登入揀快餐、設定揀堂食 → 出嚟嘅 QR 同佢預期唔同）。
 *
 * 所以：**登入模式 = 唯一入口**；設定頁**唔再**提供模式選擇器，只顯示
 * 當前模式對應嘅 QR（唯讀）。
 *
 * ## 映射表
 *
 * | 登入模式 | 店級 `scan_mode` | 客人掃到 |
 * |---|---|---|
 * | `quick`（快餐） | `quick` | 全店一碼 `/quick?store=` |
 * | `dinein`（堂食） | `dine_in` | 每枱一碼 `/menu?tableId=` |
 * | `kiosk`（自助點餐機） | **唔改**（`null`） | 唔適用（客人在該機直接落單） |
 * | `salon`（美容） | **唔改**（`null`） | 唔適用 |
 * | `kitchen`（後廚屏） | **唔改**（`null`） | 唔適用 |
 * | `expo`（出餐台屏） | **唔改**（`null`） | 唔適用 |
 *
 * ## ⚠️ 為什麼 `kiosk` / `salon` / `kitchen` / `expo` 一定要回 `null`
 *
 * 呢四個都係**裝置角色**（「呢部機開機做乜」），唔係「全店客人點樣落單」。
 * 一間堂食店完全可以同時有「收銀台（堂食登入）」＋「自助點餐機（kiosk 登入）」
 * ＋「廚房屏（kitchen 登入）」＋「水吧屏（kitchen 登入，另一個工位）」。
 * 如果佢哋任何一個都寫 `quick`，就會出現：
 *
 *   kiosk 機綁店 → 寫 `quick` → 店家喺收銀台用堂食登入 → 寫返 `dine_in`
 *   → 四部機互相覆蓋，設定頁顯示嘅碼**每次登入都唔同**。
 *
 * 呢個正是 docs/115 §12.2 講嘅「兩部機打架」，所以呢四個模式一律**不寫**。
 * 需要區分時，`scanModeForLoginMode()` 回 `null` 就係「唔關店級設定事」嘅信號。
 *
 * ⚠️ 後廚屏（`kitchen`）**唔需要**工位資訊 —— 工位係**設備屬性**，
 * 由 `KdsDeviceBinding.station` 決定（docs/116 §4.4），同店級設定完全無關。
 *
 * 純函式、零 runtime 依賴（只 `import type`）→ 可以直接被 `node --test` 覆蓋。
 */
export type LoginMode = "quick" | "dinein" | "salon" | "kiosk" | "kitchen" | "expo";

/**
 * 回傳要寫入店級設定嘅 `ScanMode`；回 `null` = **唔應該改店級設定**。
 *
 * 呼叫方（`login-screen.tsx`）見到 `null` 就要跳過 POST，唔可以當 `dine_in` 處理
 * ——否則 kiosk / salon / kitchen / expo 登入會靜靜把全店掃碼模式洗返堂食。
 */
export function scanModeForLoginMode(mode: LoginMode): ScanMode | null {
  if (mode === "quick") return "quick";
  if (mode === "dinein") return "dine_in";
  return null;
}
