import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  buildPosOrdersProbeUrl,
  describePosRealtimeProbe,
  isBadApiKeyBody,
  isPosRealtimeHealthy,
  probePosRealtimeTarget,
  resolvePosRealtimeConfig,
  safeHost,
  type PosRealtimeConfig,
  type PosRealtimeProbe,
} from "./realtime-target.ts";

const POS_CONFIG: PosRealtimeConfig = {
  url: "https://posproj.supabase.co",
  anonKey: "pos-anon",
  source: "pos",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** 用假的 fetch 換走真網絡，順便記低收到嘅請求。 */
function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { calls };
}

describe("resolvePosRealtimeConfig", () => {
  it("有 POS 專用變數時用 pos 來源（優先於舊變數）", () => {
    const config = resolvePosRealtimeConfig({
      NEXT_PUBLIC_POS_SUPABASE_URL: "https://pos.supabase.co",
      NEXT_PUBLIC_POS_SUPABASE_ANON_KEY: "pos-key",
      NEXT_PUBLIC_SUPABASE_URL: "https://ledger.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "ledger-key",
    });
    assert.deepEqual(config, {
      url: "https://pos.supabase.co",
      anonKey: "pos-key",
      source: "pos",
    });
  });

  it("冇 POS 變數時退回舊變數並標記為 ledger-fallback", () => {
    const config = resolvePosRealtimeConfig({
      NEXT_PUBLIC_SUPABASE_URL: "https://ledger.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "ledger-key",
    });
    assert.deepEqual(config, {
      url: "https://ledger.supabase.co",
      anonKey: "ledger-key",
      source: "ledger-fallback",
    });
  });

  it("POS 變數只有一半（冇 key）時唔會採用，退回舊變數", () => {
    const config = resolvePosRealtimeConfig({
      NEXT_PUBLIC_POS_SUPABASE_URL: "https://pos.supabase.co",
      NEXT_PUBLIC_SUPABASE_URL: "https://ledger.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "ledger-key",
    });
    assert.equal(config?.source, "ledger-fallback");
  });

  it("完全冇配置回 null", () => {
    assert.equal(resolvePosRealtimeConfig({}), null);
  });

  it("空字串／只有空白當作未設定", () => {
    assert.equal(
      resolvePosRealtimeConfig({
        NEXT_PUBLIC_POS_SUPABASE_URL: "   ",
        NEXT_PUBLIC_POS_SUPABASE_ANON_KEY: "",
      }),
      null,
    );
  });

  it("值前後有空白會 trim", () => {
    const config = resolvePosRealtimeConfig({
      NEXT_PUBLIC_POS_SUPABASE_URL: "  https://pos.supabase.co  ",
      NEXT_PUBLIC_POS_SUPABASE_ANON_KEY: "  pos-key  ",
    });
    assert.equal(config?.url, "https://pos.supabase.co");
    assert.equal(config?.anonKey, "pos-key");
  });
});

describe("safeHost", () => {
  it("正常 URL 抽 host", () => {
    assert.equal(safeHost("https://abc.supabase.co"), "abc.supabase.co");
  });

  it("唔合法嘅字串原樣回短版（唔會拋錯）", () => {
    assert.equal(safeHost("not a url"), "not a url");
  });

  it("null 回 null", () => {
    assert.equal(safeHost(null), null);
  });
});

describe("buildPosOrdersProbeUrl", () => {
  it("基本組合", () => {
    assert.equal(buildPosOrdersProbeUrl("https://x.supabase.co"), "https://x.supabase.co/rest/v1/pos_orders?select=id&limit=1");
  });

  it("尾部斜線唔會變雙斜線", () => {
    assert.equal(
      buildPosOrdersProbeUrl("https://x.supabase.co///"),
      "https://x.supabase.co/rest/v1/pos_orders?select=id&limit=1",
    );
  });
});

describe("describePosRealtimeProbe / isPosRealtimeHealthy", () => {
  const statuses: PosRealtimeProbe["status"][] = [
    "ok",
    "unconfigured",
    "table_missing",
    "bad_key",
    "unauthorized",
    "error",
  ];

  it("每個狀態都有非空描述", () => {
    for (const status of statuses) {
      const text = describePosRealtimeProbe({ status, source: null, host: null });
      assert.ok(text.length > 0, `${status} 應該有描述`);
    }
  });

  it("只有 ok 算健康", () => {
    for (const status of statuses) {
      assert.equal(isPosRealtimeHealthy({ status, source: null, host: null }), status === "ok");
    }
    assert.equal(isPosRealtimeHealthy(null), false);
  });
});

describe("isBadApiKeyBody", () => {
  it("認得 PostgREST 嘅錯 key 文案", () => {
    assert.equal(isBadApiKeyBody('{"message":"Invalid API key"}'), true);
    assert.equal(isBadApiKeyBody('{"message":"No API key found in request"}'), true);
    assert.equal(isBadApiKeyBody('{"message":"JWT expired"}'), true);
  });

  it("唔會誤認 RLS 拒絕", () => {
    assert.equal(isBadApiKeyBody('{"code":"42501","message":"permission denied for table pos_orders"}'), false);
    assert.equal(isBadApiKeyBody(""), false);
  });
});

describe("probePosRealtimeTarget", () => {
  it("冇配置 → unconfigured，唔會發請求", async () => {
    const { calls } = stubFetch(() => new Response("{}", { status: 200 }));
    const probe = await probePosRealtimeTarget(null);
    assert.equal(probe.status, "unconfigured");
    assert.equal(calls.length, 0);
  });

  it("200 → ok，並帶 apikey / Authorization header 同正確 URL", async () => {
    const { calls } = stubFetch(() => new Response("[]", { status: 200 }));
    const probe = await probePosRealtimeTarget(POS_CONFIG);
    assert.equal(probe.status, "ok");
    assert.equal(probe.host, "posproj.supabase.co");
    assert.equal(probe.source, "pos");
    assert.equal(calls[0]?.url, "https://posproj.supabase.co/rest/v1/pos_orders?select=id&limit=1");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers.apikey, "pos-anon");
    assert.equal(headers.Authorization, "Bearer pos-anon");
  });

  it("404 + PGRST205 → table_missing（訂錯專案）", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            code: "PGRST205",
            message: "Could not find the table 'public.pos_orders' in the schema cache",
          }),
          { status: 404 },
        ),
    );
    const probe = await probePosRealtimeTarget(POS_CONFIG);
    assert.equal(probe.status, "table_missing");
  });

  it("404 但 body 唔含 PGRST205 一律當 table_missing", async () => {
    stubFetch(() => new Response("not found", { status: 404 }));
    const probe = await probePosRealtimeTarget(POS_CONFIG);
    assert.equal(probe.status, "table_missing");
  });

  it("401 Invalid API key → bad_key（唔可以報成 unauthorized/表存在）", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            message: "Invalid API key",
            hint: "Double check your Supabase `anon` or `service_role` API key.",
          }),
          { status: 401 },
        ),
    );
    const probe = await probePosRealtimeTarget(POS_CONFIG);
    assert.equal(probe.status, "bad_key");
  });

  it("401 No API key found → bad_key", async () => {
    stubFetch(() => new Response(JSON.stringify({ message: "No API key found in request" }), { status: 401 }));
    const probe = await probePosRealtimeTarget(POS_CONFIG);
    assert.equal(probe.status, "bad_key");
  });

  it("401 permission denied（key 有效但 anon 冇 select）→ unauthorized", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ code: "42501", message: "permission denied for table pos_orders" }), {
          status: 401,
        }),
    );
    const probe = await probePosRealtimeTarget(POS_CONFIG);
    assert.equal(probe.status, "unauthorized");
  });

  it("bad_key 唔會被誤判成 table_missing（404 以外的狀態碼）", async () => {
    stubFetch(() => new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 }));
    const probe = await probePosRealtimeTarget(POS_CONFIG);
    assert.notEqual(probe.status, "table_missing");
  });

  it("42501 → unauthorized（RLS 擋 anon）", async () => {
    stubFetch(() => new Response(JSON.stringify({ code: "42501" }), { status: 400 }));
    const probe = await probePosRealtimeTarget(POS_CONFIG);
    assert.equal(probe.status, "unauthorized");
  });

  it("500 → error 並帶狀態碼", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    const probe = await probePosRealtimeTarget(POS_CONFIG);
    assert.equal(probe.status, "error");
    assert.match(probe.detail ?? "", /500/);
  });

  it("fetch 拋錯（斷網 / timeout）→ error，唔會 throw", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const probe = await probePosRealtimeTarget(POS_CONFIG, 10);
    assert.equal(probe.status, "error");
    assert.match(probe.detail ?? "", /network down/);
  });

  it("探測唔會傳出 anon key 到 host 欄位", async () => {
    stubFetch(() => new Response("[]", { status: 200 }));
    const probe = await probePosRealtimeTarget(POS_CONFIG);
    assert.equal(probe.host?.includes("pos-anon"), false);
  });
});
