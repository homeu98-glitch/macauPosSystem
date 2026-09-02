// GET /api/pos/print-agent/pair-status?storeId= — web 查呢間店有冇已配對嘅中繼機。
// 對應 docs/96 §8「Android 自註冊」流程：APK 自行 POST /pair 註冊後，
// web 唔使攞 token（token 只存 hash，web 唔需要），淨係查「呢間店有冇 agent 配對咗」。
// 回agentId 唔係秘密（同 QR 一樣公開），web 攞嚟寫落 localStorage 決定 isRelayConfigured()。
import { NextResponse } from "next/server";

import { getSupabaseWriteClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const STORE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = (searchParams.get("storeId") ?? "").trim();
  if (!storeId || !STORE_ID_PATTERN.test(storeId) || storeId.length > 64) {
    return NextResponse.json({ paired: false }, { status: 400 });
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({ paired: false, error: "Supabase 未配置" }, { status: 503 });
  }

  // ⚠️ 唔好 select `store_name` —— `pos_print_agents` 冇呢條欄（0020 只喺 pos_print_jobs 加咗）。
  // Select 佢會 42703 → 呢度變 500 → web 顯示「配對失敗」，但其實一早配對成功咗。
  const { data, error } = await supabase
    .from("pos_print_agents")
    .select("agent_id, store_id, name")
    .eq("store_id", storeId)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ paired: false, error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ paired: false });
  }
  return NextResponse.json({
    paired: true,
    agentId: data.agent_id,
    storeId: data.store_id,
    storeName: null, // agents 表冇 store_name；web 端由 auth session 攞店名
  });
}
