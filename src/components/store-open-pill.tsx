"use client";

import { useEffect, useState } from "react";

import { MerchantOpenPill } from "@/components/merchant-open-pill";
import { loadAuthSession } from "@/lib/storage";
import { useMerchantOrderConfig } from "@/lib/pos/use-merchant-order-config";
import { useStoreStatus } from "@/lib/pos/use-store-status";

/**
 * 設置頁 header 嘅「**店內營業**」開關 —— 放喺「線上接單」左邊。
 *
 * ── 呢粒同「線上接單」係兩個獨立開關（🔴 唔可以撈埋）────────────────────
 * | 掣 | 真源 | 關咗之後 |
 * |---|---|---|
 * | **線上接單**（隔籬） | Ledger `merchant_enabled`（RPC ＋ 0036 鏡像） | 只擋會員通線上落單 |
 * | **店內營業**（本檔） | POS DB `pos_store_status`（0039） | 擋掃碼點餐（`/menu`、`/quick`）＋ kiosk（`/order`） |
 *
 * ⇒ 所以**兩粒掣嘅確認文案一定要唔同**：`MerchantOpenPill` 預設嗰句寫明
 * 「店內堂食、快餐、自助點餐不受影響」，套落呢粒掣就會講大話 —— 本檔自己傳文案。
 *
 * ── 單向連動（2026-09-14 J 拍板）────────────────────────────────────────
 * - 關「店內營業」→ **順手暫停「線上接單」**（客人既然落唔到掃碼／kiosk 單，
 *   就唔應該再由會員通落單）。做法係叫 Ledger RPC，真源仍然只有 Ledger 一個。
 * - 切換「線上接單」→ **唔會**影響「店內營業」。
 * - **重開**「店內營業」→ **唔會**自動開返「線上接單」（原本暫停可能係店主刻意決定），
 *   只出提示叫收銀自己撳。
 *
 * ── 誠實顯示（唔准猜）──────────────────────────────────────────────────
 * `isOpen === null`（未讀到）→ 掣面「未接通」＋停用。**唔可以**當「已暫停」或者
 * 「營業中」：前者會令收銀白撳，後者會令收銀以為停咗業其實冇。
 *
 * ⚠️ 連動失敗（Ledger 未登入 / RPC 未上線）**唔會**阻住關店：店內已由 POS 自己
 * 擋住，只係線上接單未同步 → 出提示叫手動撳（見 2026-09-14 拍板）。
 */

/** 關店確認文案 —— 一定要講清楚影響掃碼／kiosk ＋ 會連帶暫停線上接單。 */
const CONFIRM_CLOSE_STORE_MESSAGE =
  "確認暫停店內營業？\n\n" +
  "客人將無法透過掃碼點餐、自助點餐機落單，同時會暫停「線上接單」（會員通）。\n" +
  "收銀台仍可正常操作（堂食落單、結帳不受影響）。\n\n" +
  "恢復營業時，喺同一個掣撳返「營業中」即可（「線上接單」唔會自動開返）。";

export function StoreOpenHeaderToggle() {
  // client-only：同 device-settings 其他 storeId 讀法一致（保 SSR/CSR 一致）
  const [storeId, setStoreId] = useState<string | null>(null);
  useEffect(() => {
    setStoreId(loadAuthSession()?.merchantId ?? null);
  }, []);

  const store = useStoreStatus(storeId, Boolean(storeId));
  const merchant = useMerchantOrderConfig(storeId, Boolean(storeId));
  /** 連動結果提示（唔用 toast：設置頁 header 唔應該彈嘢遮住其他掣）。 */
  const [notice, setNotice] = useState<string | null>(null);

  async function handleChange(next: boolean) {
    setNotice(null);

    const saved = await store.setStoreOpen(next);
    if (!saved) return; // 寫唔到 DB：pill 已 rollback + 顯示 error，唔好再連動

    if (!next) {
      // ── 關店：單向連動「線上接單」──
      if (merchant.merchantEnabled === true) {
        if (!merchant.available) {
          setNotice("店內已暫停；但 Ledger 通道用唔到，線上接單未同步，請手動撳。");
          return;
        }
        const synced = await merchant.setMerchantEnabled(false);
        if (!synced) {
          setNotice("店內已暫停；線上接單未能同步暫停，請撳隔籬嗰粒掣手動暫停。");
        }
        return;
      }
      if (merchant.merchantEnabled === null) {
        // 未讀到就唔好亂寫 RPC（同 useMerchantOrderConfig 嘅紀律一致）
        setNotice("店內已暫停；線上接單狀態未讀到，請自行確認要唔要一齊暫停。");
      }
      return;
    }

    // ── 重開：唔自動開返線上接單，只提示 ──
    if (merchant.merchantEnabled === false) {
      setNotice("已恢復店內營業。線上接單仍暫停，如需接單請撳隔籬嗰粒掣。");
    }
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <MerchantOpenPill
        busy={store.loading || store.saving}
        busyHint={store.loading ? "（讀取中…）" : store.saving ? "（切換中…）" : undefined}
        confirmMessage={CONFIRM_CLOSE_STORE_MESSAGE}
        disabled={!storeId}
        error={store.error}
        label="店內營業"
        merchantEnabled={store.isOpen}
        onChange={(next) => void handleChange(next)}
        unknownHint={
          storeId
            ? "未讀到營業狀態（可能係讀取失敗），請重新載入頁面。"
            : "尚未登入，無法讀取營業狀態。"
        }
        variant="contained"
      />
      {notice ? (
        <span className="max-w-[240px] text-[11px] font-semibold leading-snug text-amber-700">
          {notice}
        </span>
      ) : null}
    </div>
  );
}
