import { NextResponse } from "next/server";

import { posRouteAuthGuard } from "@/lib/pos/pos-route-auth";
import { readAgentHeaders, verifyAgent } from "@/lib/print-agent-server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { normalizeDeviceConfig, normalizePosLocalSettings } from "@/lib/storage";

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!supabase) {
    return NextResponse.json({ ok: true, deviceConfig: null, localSettings: null });
  }

  // 🛡️ 加固（db review §4.1 #2）：冇 storeId 唔可以拎「全平台 updated_at 最新一行」，
  // 否則會把別店 terminal 配置（含打印機綁定 / local_settings）拉落嚟（見 docs/98 問題二）。
  // 冇 storeId → 返 null，寧可本機 localStorage 配置生效，都唔好洩露別店 terminal 設定。
  //
  // ⚠️ 呢個 early-return 刻意放喺 auth 閘**之前**：佢本來就唔會洩露任何嘢，
  // 保留原位可以令「mock / 冇 storeId」嘅既有回應完全唔變。
  if (!storeId) {
    return NextResponse.json({ ok: true, deviceConfig: null, localSettings: null });
  }

  /**
   * 🔒 授權（兩條路，任一條通過）：
   *
   * 1. **POS 終端 / admin session**（`posRouteAuthGuard`）—— POS「打印中心」／KDS 用。
   * 2. **🆕 中繼機（print-agent）憑證**（2026-09-16）—— 雲端打印中繼 APK 用。
   *
   * 為何要開第 2 條：中繼 APK（`print-relay` / `macau-ledger-merchant`）由
   * `RelayApi.fetchDeviceConfig()` 拉本端點攞打印機路由配置（IP:port），而佢**冇 POS 憑證**
   * （只有配對時攞到嘅 `agentId` + `agentToken`）。2026-09-16 加閘之後佢一定 401，
   * 令中繼機重啟後失去權威路由、退到 LAN 發現揀機（多打印機嘅店可能印錯機）。
   *
   * 規格見 `docs/integration/print-relay-device-config-runbook.md`（§3）＋
   * `docs/integration/print-relay-hardening-brief.md`（§8）。
   *
   * 🔴 一定要驗 `agent.storeId === storeId`（綁店）—— 否則任何一部中繼機嘅憑證
   * 都可以讀別店嘅打印機配置。`verifyAgent()` 已經驗 `revoked_at is null` +
   * `sha256(token) === token_hash`，唔好另寫一套驗證。
   */
  const { agentId, token } = readAgentHeaders(request);
  const agent = agentId && token ? await verifyAgent(agentId, token) : null;
  const viaAgent = Boolean(agent && agent.storeId === storeId);

  if (!viaAgent) {
    const denied = posRouteAuthGuard(request, storeId, "pos/device-config");
    if (denied) return denied;
  } else {
    console.info(`[pos/device-config] 中繼機憑證通道（agent=${agentId}, store=${storeId}）`);
  }

  const { data, error } = await supabase
    .from("pos_device_configs")
    .select("*")
    .eq("store_id", storeId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    deviceConfig: data
      ? normalizeDeviceConfig({
          deviceId: data.device_id,
          terminalName: data.terminal_name,
          storeId: data.store_id,
          printers: Array.isArray(data.printers) ? data.printers : [],
          updatedAt: data.updated_at,
        })
      : null,
    /**
     * 🔻 最小權限（2026-09-16）：中繼機只讀 `deviceConfig.printers`
     * （`print-relay/RelayApi.kt:231-232`；已核對兩個中繼 App 都**冇**用 `localSettings`），
     * 而 `local_settings.printZones` 係 KDS 分區嘅權威來源 ⇒ 中繼憑證通道一律回 `null`。
     * POS 終端 / admin 路徑行為完全不變。
     */
    localSettings:
      !viaAgent && data?.local_settings ? normalizePosLocalSettings(data.local_settings) : null,
  });
}

export async function POST(request: Request) {
  const payload = await request.json();
  const supabase = getSupabaseServerClient();

  // 🔒 2026-09-15 資安加固：只喺真正會寫 DB 嘅情況（supabase 已配置）才要求憑證 ——
  // 未配置時本端點本來就唔寫任何嘢，保留原有「只回 ok」行為完全不變。
  if (supabase) {
    const storeId = typeof payload?.storeId === "string" ? payload.storeId.trim() || null : null;
    const denied = posRouteAuthGuard(request, storeId, "pos/device-config");
    if (denied) return denied;
  }

  if (supabase && payload?.action !== "test-print") {
    const { error } = await supabase.from("pos_device_configs").upsert(
      {
        device_id: payload.deviceId,
        store_id: payload.storeId,
        terminal_name: payload.terminalName,
        printers: payload.printers,
        local_settings: payload.localSettings ?? null,
        updated_at: payload.updatedAt ?? new Date().toISOString(),
      },
      { onConflict: "device_id" },
    );

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    message: "已接收設備設定事件",
    receivedAt: new Date().toISOString(),
    payload,
  });
}
