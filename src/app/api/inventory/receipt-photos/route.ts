import { NextResponse } from "next/server";

import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import { resolveExpenseUserId, sanitizePhotoPaths } from "@/lib/expense-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 收據相片上傳／刪除（存 expenseRecorder Storage）。
 *
 * 🔴 為何唔喺前端直連 Supabase Storage？
 *   前端的 `NEXT_PUBLIC_*` 只有 POS 專案（iyrywzormzisyppkokbi）嘅 anon key，
 *   而相片要存喺 **expenseRecorder**（fjvfvpedklhdenavbcjg）—— 跨專案。
 *   由 POS 後端用 **service_role** 代為上傳，可以：
 *     ① 唔使把 expense 專案嘅 key 下發到 iPad；
 *     ② **bypass RLS** ⇒ 唔需要喺 expense 專案寫複雜嘅 Storage policy；
 *     ③ 伺服器統一驗大小（200KB 硬要求嘅最後防線，見下）。
 *
 * Exports:
 *   POST   multipart/form-data: account + file → { ok, path }
 *   DELETE ?account=...&paths=a.jpg,b.jpg        → { ok, deleted }
 */

/** 🔴 J 2026-10-07 硬要求：上傳必須 200KB 以下。前端已壓縮，呢度係最後防線。 */
const MAX_BYTES = 200 * 1024;

/** Bucket 名（private）。要喺 expenseRecorder 專案先建立，見 docs 方案 §4B.3。 */
const BUCKET = "receipt-photos";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

type DbError = { code?: string; message?: string } | null;

/**
 * Storage bucket 唔存在（或用 service_role 都冇權限）嘅判別。
 *
 * 🔴 唔可以一律當 500：bucket 要人手喺 Dashboard 建，
 *    POS 部署完但 bucket 未建係**預期會發生**嘅中間狀態。
 *    呢個時候要回一句商家睇得明、而且**唔會令收據儲存失敗**嘅訊息
 *    （前端設計成相片失敗唔阻擋收據）。
 */
function isMissingBucket(err: DbError): boolean {
  if (!err) return false;
  const msg = err.message ?? "";
  return /bucket not found|Bucket not found|does not exist/i.test(msg);
}

/** 由 MIME 推副檔名。唔靠原檔名（iPad 影出黎係 `IMG_1234.HEIC`，同實際內容可能唔一致）。 */
function extFor(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

/**
 * 路徑規則：`{userId}/{yyyy-mm}/{uuid}.{ext}`
 *
 * 🔴 為何開頭一定要 `userId`？
 *   雖然 service_role 唔受 RLS 管，但呢個係 **defense in depth**：
 *   刪除時可以靠 `remove(paths.filter(p => p.startsWith(userId + "/")))` 擋住
 *   「A 店用 B 店嘅 path 去刪檔案」。冇呢層就變成任意路徑刪除。
 *
 * 🔴 為何要 `yyyy-mm` 分層？
 *   ① Dashboard 上易睇（一個月一疊）；
 *   ② 將來若要清理舊相，可以按前綴批量處理。
 *
 * ⚠️ 用 `crypto.randomUUID()` 而唔係原檔名：原檔名可能重複（`IMG_0001.jpg`），
 *    亦可能含中文／空格令 Storage key 出問題。
 */
function buildPath(userId: string, ext: string): string {
  const now = new Date();
  // 用 UTC 年月做分層就夠 —— 呢度只係檔案擺放，唔涉及業務日期。
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${userId}/${ym}/${crypto.randomUUID()}.${ext}`;
}

/**
 * 收集 `raw_ocr_data.photo_paths` 嘅合法值。
 *
 * 🔴 同 `receipts/[id]/route.ts` PATCH 一樣要 `!== undefined` 語意：
 *    空陣列 = 商家主動刪光相片，係一個**有效指令**，唔可以當「冇提供」。
 *    實際清洗規則抽去 `sanitizePhotoPaths()`（`expense-inventory.ts`）共用。
 */

export async function POST(request: Request) {
  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "需要 multipart/form-data" }, { status: 400 });
  }

  const account = form.get("account");
  const resolved = await resolveExpenseUserId(client, typeof account === "string" ? account : null);
  if ("error" in resolved) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  const userId = resolved.userId;

  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "缺少 file" }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ ok: false, error: "檔案是空的" }, { status: 400 });

  /*
   * 🔴 大小閘（硬要求）。前端已壓縮，但前端可以被繞過（直接打 API），
   *    而且前端壓縮有機會走完階梯都唔達標 —— 呢度一定唔可以放行。
   *    ⚠️ 用 strict `>`：要求係「200kb **以下**」，剛好 204800 都唔算。
   */
  if (file.size >= MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: `圖片 ${Math.round(file.size / 1024)}KB 超過 200KB 上限，請先壓縮。` },
      { status: 413 },
    );
  }

  const mime = (file.type || "").toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return NextResponse.json(
      { ok: false, error: "只接受 JPEG／PNG／WebP 圖片。" },
      { status: 415 },
    );
  }

  const path = buildPath(userId, extFor(mime));
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error } = await client.storage.from(BUCKET).upload(path, buffer, {
    contentType: mime,
    upsert: false,
  });
  if (error) {
    if (isMissingBucket(error)) {
      // 降級：回 503 + 清楚指示。前端會顯示提示但**收據照存**。
      return NextResponse.json(
        { ok: false, error: `相片上傳失敗：Storage bucket「${BUCKET}」未建立。`, code: "BUCKET_MISSING" },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, path });
}

/**
 * 刪除相片。
 *
 * 用途有二：
 *  ① 商家喺 modal 內移除單張相（唔使等刪收據）；
 *  ② **刪收據時一併清理**（`receipts/[id]` DELETE 會呼叫此邏輯）——
 *     否則 Storage 會累積孤兒檔案，免費額度（1GB）幾個月就滿。
 *
 * 🔴 只刪 `userId/` 前綴底下嘅路徑：防「用 B 店 path 刪 A 店以外檔案」。
 * 🔴 刪唔到唔可以當失敗：Storage 少一個檔案係小事，
 *    但令商家「刪唔到收據」係大事。所以刪檔案失敗只記錄，照回 ok。
 */
export async function DELETE(request: Request) {
  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const { searchParams } = new URL(request.url);
  const resolved = await resolveExpenseUserId(client, searchParams.get("account"));
  if ("error" in resolved) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  const userId = resolved.userId;

  const requested = sanitizePhotoPaths(searchParams.getAll("paths").flatMap((p) => p.split(",")));
  const owned = requested.filter((p) => p.startsWith(`${userId}/`));
  if (owned.length === 0) return NextResponse.json({ ok: true, deleted: 0 });

  const { error } = await client.storage.from(BUCKET).remove(owned);
  if (error) {
    // 見上面註解：唔可以讓「刪相失敗」升級成「刪收據失敗」。
    console.warn("[receipt-photos] remove failed", { count: owned.length, message: error.message });
    return NextResponse.json({ ok: true, deleted: 0, warning: error.message });
  }

  return NextResponse.json({ ok: true, deleted: owned.length });
}
