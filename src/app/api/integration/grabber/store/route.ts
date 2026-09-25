import { NextResponse } from "next/server";

import {
  grabberSecretsMatch,
  readGrabberSecretFromRequest,
  readGrabberSharedSecret,
} from "@/lib/grabber/grabber-secret";
import { getSupabaseServerClient } from "@/lib/supabase-server";

/**
 * 外賣平台插件 → POS：**查店名**（2026-09-25）。
 *
 * ── 為什麼要有呢條端點 ────────────────────────────────────────────────
 * 插件 popup 有一個「Store ID」輸入格。商家打錯／貼錯 Store ID 嘅話，
 * 訂單會靜靜咁推去**另一間店**（或者被 POS 拒收），表面上完全冇症狀。
 * 實案（2026-09-25）：商家換咗 store id 之後，訂單一直「送出失敗」，
 * 查咗三輪才發現係推去另一間店 + PK 衝突。
 * ⇒ 輸入完即刻顯示「呢個 ID 係邊間店」＝最低成本嘅防錯。
 *
 * ── 資料來源 ─────────────────────────────────────────────────────────
 * `pos_bootstrap_config (store_id pk, store_name)` —— POS 登入時由 Ledger 寫入。
 * 未見過該店（未喺 POS 登入過）→ 回 404，插件顯示「查唔到此店」，
 * 順便當成「呢個 ID 可能打錯」嘅提示。
 *
 * ── 授權 ─────────────────────────────────────────────────────────────
 * 同 `grabber/orders` 一樣用 `X-Grabber-Secret`（constant-time 比對）。
 * **唯讀、只回店名**（唔回任何訂單／金額／客戶資料）。
 */

export async function POST(request: Request) {
  const expected = readGrabberSharedSecret();
  if (!expected) {
    console.error("[integration/grabber/store] GRABBER_SHARED_SECRET 未設定");
    return NextResponse.json({ ok: false, error: "伺服器未設定共享密鑰。" }, { status: 500 });
  }

  if (!grabberSecretsMatch(readGrabberSecretFromRequest(request), expected)) {
    return NextResponse.json({ ok: false, error: "密鑰驗證失敗。" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await request.text()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "JSON body 格式錯誤。" }, { status: 400 });
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON body 格式錯誤。" }, { status: 400 });
  }

  const storeId = typeof payload.storeId === "string" ? payload.storeId.trim() : "";
  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId。" }, { status: 400 });
  }
  // 防呆：store id 係 UUID 或短字串，唔應該有路徑／SQL 味道嘅內容。
  if (storeId.length > 128) {
    return NextResponse.json({ ok: false, error: "storeId 格式不合理。" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 伺服器端未配置。" }, { status: 503 });
  }

  const { data, error } = await supabase
    .from("pos_bootstrap_config")
    .select("store_id, store_name, currency")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: `查詢失敗：${error.message}` }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json(
      {
        ok: false,
        // 空白 store_name 都當「查唔到」—— 唔可以回一個空名畀插件當成功（會誤導）
        error: "查唔到呢間店（呢個 Store ID 未喺 POS 登入過，請確認有冇打錯）。",
      },
      { status: 404 },
    );
  }

  const storeName = typeof data.store_name === "string" ? data.store_name.trim() : "";
  if (!storeName) {
    return NextResponse.json(
      { ok: false, error: "呢間店未設定店名（POS 登入過但 bootstrap 未有 store_name）。" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    ok: true,
    storeId: data.store_id,
    storeName,
    currency: data.currency ?? null,
  });
}
