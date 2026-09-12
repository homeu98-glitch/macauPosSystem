import {
  clearKdsDeviceBinding,
  loadKdsDeviceBinding,
  saveKdsDeviceBinding,
} from "@/lib/kds/device-binding";
import { saveKioskDeviceBinding, saveKioskMode } from "@/lib/kiosk-order";
import { setTerminalIndustry } from "@/lib/salon/industry-config";
import { saveActiveSalonStore } from "@/lib/salon/storage";
import { saveOperatingMode, type AuthSession } from "@/lib/storage";
import { findWorkbench, type WorkbenchId } from "@/lib/pos/module-catalog";
import { saveKioskSettings } from "@/lib/pos/kiosk-settings";
import { posDeviceAuthHeaders } from "@/lib/pos/pos-sync-auth";
import { scanModeForLoginMode, type LoginMode } from "@/lib/pos/scan-mode-from-login";

/**
 * 「揀完工作台之後要發生咩事」—— 由 `login-screen.tsx` 搬出嚟。
 *
 * ## 為什麼要抽呢一層
 *
 * 登入流程改版之後（migration 0037 / docs/127），工作台唔再喺登入頁揀，
 * 而係**登入成功之後**喺 `/select-workbench` 揀。呢堆副作用（綁店、寫店級掃碼模式、
 * 綁 KDS 崗位…）本來寫死喺登入成功嗰一刻，因為當時 `mode` 已經知道。
 * 而家要等用戶揀，所以一定要抽成獨立、可以被第二個畫面呼叫嘅函式 ——
 * 而且**只能有一份**：抄一份去新頁 = 兩個地方各寫一半，日後必然走樣。
 *
 * ## 呼叫時序（好重要）
 *
 * 一定要喺 `saveAuthSession()` **之後**呼叫：下面嘅
 * `POST /api/pos/kiosk-settings` 要帶 POS 終端憑證，而憑證就喺
 * `authSession.posDeviceToken`（登入 API 已簽發）。
 *
 * ## 失敗口徑
 *
 * 呢個函式**唔會 throw**。所有網路操作（寫店級掃碼模式）都係「順手對齊設定」，
 * 失敗就保留 DB 舊值 —— 唔可以因為寫唔到一個 QR 設定就令部機入唔到 POS。
 */

export type ApplyWorkbenchResult = {
  /** 揀完之後應該去邊。 */
  homePath: string;
};

/** 裝置角色一律唔改店級掃碼設定（kiosk / kitchen / expo）。 */
function loginModeOf(id: WorkbenchId): LoginMode | null {
  // `retail` 係新增嘅工作台，冇對應嘅 `LoginMode`（唔涉掃碼點餐）。
  return id === "retail" ? null : id;
}

/**
 * 把「所選工作台」落實到本機 + 店級設定，並回傳要跳去邊。
 *
 * @param workbench 用戶喺 `/select-workbench` 揀嘅工作台。
 * @param session   登入拎到嘅 session（**必須已經 `saveAuthSession()` 過**）。
 */
export async function applyWorkbenchSelection(
  workbench: WorkbenchId,
  session: AuthSession,
): Promise<ApplyWorkbenchResult> {
  const def = findWorkbench(workbench);
  const homePath = def?.homePath ?? "/";

  // ── 終端行業：每次都明確寫，唔留舊值 ──
  // ⚠️ 呢度同舊行為有少少分別：舊 code 只喺「揀美容」時寫 `salon`，
  // 從來冇寫返 `restaurant`。以前一部機好少切換模式所以睇唔到問題；
  // 改版之後同一部機可以日日切工作台 —— 如果唔寫返，喺美容機揀完美容、
  // 再揀堂食收銀台，個終端會**仍然當自己係美容院**。
  setTerminalIndustry(workbench === "salon" ? "salon" : "restaurant");

  // ── 自助點餐機：綁呢台機到所屬店 + 開本機 kiosk 旗標 ──
  // ⚠️ 呢度**唔可以** early return 掉 staff session（docs/87 P0-7）。
  // 自助點餐機要做 Ledger 會員扣款（`lookupCustomerWallet` / `applyPosDeduct`），
  // 而呢啲 RPC 必須喺 authenticated session 下 call（權限由 `auth.uid()` /
  // `is_merchant_staff()` 保證），service_role 取代唔到。
  if (workbench === "kiosk") {
    // ⚠️ 唔好 `?? DEFAULT_KIOSK_STORE_ID`。
    // `macau-store-a` 係示範店代碼（唔係 merchants.id），寫落綁定之後
    // `resolveStoreId()` 會拎到佢 → sync 落 pos_print_jobs.store_id →
    // 雲端中繼「配咗對但一張單都印唔出」（最難 debug 嗰種 silent failure）。
    // 冇 merchantId 就**唔好寫綁定**：`resolveStoreId()` 會返 undefined，
    // sync 大聲 400 提示重新登入 —— 好過靜默寫錯店。
    if (session.merchantId) {
      saveKioskDeviceBinding({
        storeId: session.merchantId,
        storeName: session.name,
        language: "zh-HK",
        boundAt: new Date().toISOString(),
      });
    } else {
      console.error(
        "[apply-workbench] kiosk 但 session 冇 merchantId —— 唔寫綁定。呢部機嘅 sync 會 400 住，重新登入拎到 merchantId 先正常。",
      );
    }
    // 「狀態同模式保持一致」：揀咗自助點餐機就順手開埋本機 kiosk 旗標，
    // 否則登入完跳一次 `/order`，**下次重開呢部機又變返收銀台**。
    //
    // ⚠️ 刻意**唔**反向做（其他工作台唔 `saveKioskMode(false)`）：kiosk 旗標係
    // 裝置設定，要停用有明確入口（`/order` 右上角「設定」→「退出自助點餐模式」）。
    // 如果每次登入都覆寫，喺同一部平板補做收銀就會靜靜熄咗 kiosk。
    saveKioskMode(true);
  }

  // ── 掃碼點餐模式：由「所選工作台」決定（docs/115 §12）──
  // 堂食收銀台 → dine_in（每枱一碼）；快餐收銀台 → quick（全店一碼）。
  //
  // ⚠️ `scanMode` 係 `null` 時（kiosk / salon / kitchen / expo / retail）**一定要跳過**：
  // 自助點餐機同收銀機可以同時存在，kiosk 寫 `quick` 會同收銀台嘅堂食登入
  // 互相覆蓋 → 設定頁每次登入顯示嘅碼都唔同。
  //
  // 離線 / 失敗都**唔可以阻住進入**：呢個只係「順手對齊設定」，
  // 失敗就保留 DB 舊值（設定頁仍然會顯示舊值，唔會出現假狀態）。
  // 用 `Promise.race` 加 2.5 秒上限，避免離線時卡住。
  const loginMode = loginModeOf(workbench);
  const loginScanMode = loginMode ? scanModeForLoginMode(loginMode) : null;
  if (loginScanMode && session.merchantId) {
    await Promise.race([
      saveKioskSettings(
        session.merchantId,
        { scanMode: loginScanMode },
        posDeviceAuthHeaders(),
      ).catch(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 2500);
      }),
    ]);
  }

  // ── 收銀台營運模式（快餐 / 堂食）──
  // 自助點餐機只做快餐（規格 5），同「快餐」模式一樣用 quick。
  // ⚠️ 後廚屏 / 出餐台屏係**裝置角色**，唔應該改店級「營運模式」——
  // 同一部機之後補做收銀，就會靜靜變咗快餐／堂食。所以呢兩個跳過。
  // ⚠️ 零售（`retail`）亦跳過：`OperatingMode` 只有 dinein / quick 兩個值，
  // 冇「零售」呢個狀態；硬寫 dinein 會污染主 POS 嘅營運模式。
  if (workbench !== "kitchen" && workbench !== "expo" && workbench !== "retail") {
    saveOperatingMode(workbench === "kiosk" || workbench === "quick" ? "quick" : "dinein");
  }

  // ── 後廚屏 / 出餐台屏：唔寫店級設定，只確保綁定唔會跨店殘留 ──
  // ⚠️ 崗位（廚房／水吧）**唔喺呢度揀** —— 要入到 `/kitchen` 先揀，
  //    揀完先寫入完整綁定（見 docs/116 §4.4）。所以呢度唔寫半截綁定。
  if (workbench === "kitchen" || workbench === "expo") {
    const existingBinding = loadKdsDeviceBinding();
    // 換咗店 **或者換咗角色** → 舊綁定一定要清。
    // 唔清就會出現「呢部機上一個角色係廚房屏、今次揀出餐台屏，但仲留住個崗位」。
    if (
      existingBinding &&
      (existingBinding.storeId !== session.merchantId || existingBinding.role !== workbench)
    ) {
      clearKdsDeviceBinding();
    }
    // 出餐台屏**唔需要崗位**（佢要睇整單核對），所以即刻寫得。
    // 廚房屏相反：要入到 `/kitchen` 揀完崗位先寫完整綁定。
    if (workbench === "expo" && session.merchantId) {
      saveKdsDeviceBinding({
        storeId: session.merchantId,
        storeName: session.name,
        role: "expo",
        boundAt: new Date().toISOString(),
      });
    }
  }

  // ── 美容：數據以 merchantId 為 scope ──
  if (workbench === "salon" && session.merchantId) {
    saveActiveSalonStore(session.merchantId);
  }

  return { homePath };
}
