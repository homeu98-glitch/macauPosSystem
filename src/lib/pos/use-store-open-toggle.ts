"use client";

import { useState } from "react";

import { useMerchantOrderConfig } from "@/lib/pos/use-merchant-order-config";
import { useStoreStatus } from "@/lib/pos/use-store-status";

/**
 * 「店內營業」開關嘅**共用行為層**（確認文案 ＋ 單向連動 ＋ 結果提示）。
 *
 * ── 點解要抽成 hook ────────────────────────────────────────────────────
 * 呢個開關嘅入口換過位（設置頁 header → 側欄商店名卡，2026-09-14），
 * 但佢嘅行為（關店要二次確認、關店連動暫停線上接單、失敗要講清楚）
 * **唔應該跟住入口一齊搬**。UI 只負責畫掣，行為全部喺呢度，
 * 下次再搬位（例如加落手機底部 nav）唔使抄一次邏輯。
 *
 * ── 兩個開關、單向連動（2026-09-14 J 拍板）──────────────────────────────
 * | 掣 | 真源 | 關咗之後 |
 * |---|---|---|
 * | 線上接單 | Ledger `merchant_enabled`（RPC） | 只擋會員通線上落單 |
 * | **店內營業**（本 hook） | POS DB `pos_store_status`（0039） | 擋掃碼點餐 ＋ kiosk |
 *
 * - 關「店內營業」→ **順手暫停「線上接單」**（客人既然落唔到店內單，唔應該再由會員通落單）
 * - 切換「線上接單」→ 唔影響「店內營業」
 * - **重開**「店內營業」→ **唔會**自動開返「線上接單」（原本暫停可能係店主刻意），只出提示
 *
 * ── 未讀到（`null`）＝ 停用，唔准猜 ─────────────────────────────────────
 * `isOpen === null` 時 `canToggle` 為 false：當「營業中」會令收銀以為停咗業其實冇；
 * 當「已暫停」會令收銀白撳。兩個方向都係講大話。
 */

/** 關店確認文案 —— 一定要講清楚影響掃碼／kiosk ＋ 會連帶暫停線上接單。 */
export const CONFIRM_CLOSE_STORE_MESSAGE =
  "確認暫停店內營業？\n\n" +
  "客人將無法透過掃碼點餐、自助點餐機落單，同時會暫停「線上接單」（會員通）。\n" +
  "收銀台仍可正常操作（堂食落單、結帳不受影響）。\n\n" +
  "恢復營業時，喺同一個掣撳返「營業中」即可（「線上接單」唔會自動開返）。";

export type StoreOpenToggle = {
  /** `null` = 未讀到（唔可以當 false）。 */
  isOpen: boolean | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /**
   * 連動結果提示（顯示完可以 dismiss）。
   *
   * ⚠️ 2026-09-14：**目前冇任何 UI 顯示佢** —— 側欄（唯一入口）嘅 72px 放唔落
   * 一句 30 字嘅提示（會 wrap 成 7 行，蓋住商店名卡），J 指示移除嗰格。
   * 判斷邏輯保留喺呢度（行為層），將來搬去闊啲嘅入口可以直接接返。
   */
  notice: string | null;
  clearNotice: () => void;
  /** 未讀到／讀寫中 → false（UI 應該停用）。 */
  canToggle: boolean;
  toggle: () => Promise<void>;
  crossTerminalSync: "instant" | "on-enter";
};

export function useStoreOpenToggle(storeId: string | null): StoreOpenToggle {
  const store = useStoreStatus(storeId, Boolean(storeId));
  const merchant = useMerchantOrderConfig(storeId, Boolean(storeId));
  const [notice, setNotice] = useState<string | null>(null);

  const canToggle = Boolean(storeId) && store.isOpen !== null && !store.loading && !store.saving;

  async function toggle(): Promise<void> {
    if (!canToggle) return;

    // 喺 await 之前捕捉意圖：`store.isOpen` 落 await 之後已經係新值
    const turningOff = store.isOpen === true;

    if (turningOff) {
      // 關店：誤觸等於停業（掃碼 ＋ kiosk 即刻落唔到單）→ 一定要問清楚
      if (typeof window !== "undefined" && !window.confirm(CONFIRM_CLOSE_STORE_MESSAGE)) return;
    }

    setNotice(null);

    const saved = await store.setStoreOpen(!turningOff);
    if (!saved) return; // 寫唔到 DB：hook 內部已 rollback ＋ 出 error，唔好再連動

    if (turningOff) {
      // ── 關店：單向連動暫停「線上接單」──
      if (merchant.merchantEnabled === true) {
        if (!merchant.available) {
          setNotice("店內已暫停；但 Ledger 通道用唔到，線上接單未同步，請去設置頁手動暫停。");
          return;
        }
        const synced = await merchant.setMerchantEnabled(false);
        if (!synced) {
          setNotice("店內已暫停；線上接單未能同步暫停，請去設置頁手動暫停。");
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
      setNotice("已恢復店內營業。線上接單仍暫停，如需接單請去設置頁開返。");
    }
  }

  return {
    isOpen: store.isOpen,
    loading: store.loading,
    saving: store.saving,
    error: store.error,
    notice,
    clearNotice: () => setNotice(null),
    canToggle,
    toggle,
    crossTerminalSync: store.crossTerminalSync,
  };
}
