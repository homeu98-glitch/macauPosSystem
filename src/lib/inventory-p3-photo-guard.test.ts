import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * P3 合約守衛（2026-10-07）：單據相片上傳／刪除。
 *
 * 釘死五件事（每一件都係「重構時最易靜靜改走、而後果嚴重」）：
 *   ① **200KB 硬要求**：壓縮階梯存在、上傳前有把關、**唔可以**「壓縮失敗照上傳」
 *   ② **private bucket**：顯示一定要經 signed URL，唔可以直接 `<img src={path}>`
 *   ③ **三態語意**：PATCH 用 `!== undefined`（否則「刪光相片」靜默失效）
 *   ④ **刪收據一併刪相**：否則 Storage 累積孤兒檔案
 *   ⑤ **失敗唔阻擋儲存**：相片上唔到都要存到收據（J 拍板）
 *
 * 🔴 `node --test` 唔認 `@/`、唔支援 render `.tsx` ⇒ 讀原始碼做字串斷言。
 * 🔴 必須先 `stripComments()`：呢個檔同被掃嘅檔都寫滿解釋陷阱嘅註解，
 *    註解入面出現同一段字串會令測試報**假 failure**（P2 實測中過）。
 * ⚠️ 唔可以用「`indexOf` + 固定窗口」做斷言（`stripComments` 會把註解換成
 *    200 個空白 ⇒ 目標可能落在被清空區之外）。需要定位時用括號追蹤。
 */

const SRC = new URL("../../", import.meta.url);

function readSrc(rel: string): string {
  return readFileSync(new URL(rel, SRC), "utf8");
}

/** 剝走註解（`//` 換成 200 空白，保留行結構）。 */
function stripComments(code: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return code
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + " ".repeat(200));
}

/**
 * 抽出一個函式嘅**主體**文字。
 *
 * 🔴 唔可以天真地搵「marker 之後第一個 `{`」：
 *    有回傳型別標註嘅函式（`function f(): T { ... }`）或者
 *    `async (): Promise<X> => { ... }` 都會令第一個 `{` 落入**型別**入面
 *    （例如 `Promise<{ id: string }>`）⇒ 抓到嘅係 `{ id: string }` 而唔係主體。
 *    P3 首次跑就係咁中招（5 條假 failure，全部回報 actual 係型別字串）。
 *
 * ✅ 做法：由 marker 開始，先跳過型別標註 ——
 *    由 marker 往後追蹤 `(` `)` 深度，行到「括號深度返 0」之後，
 *    再容許一段型別文字（`:` 之後唔可以有 `;` 或 `=`），
 *    最後遇到嘅第一個 `{` 才是函式主體。
 */
function bodyAfter(src: string, marker: string): string | null {
  const idx = src.indexOf(marker);
  if (idx < 0) return null;

  /*
   * 由 marker 開始，逐個 `{` 檢查「佢係唔係函式主體」。
   *
   * 判別法：一個 `{` 係主體 ⟺ 喺佢**之前**、由 marker 起，出現過 `)` 或者 `=>`。
   *   - `function f(a): { x: T } {` → 型別 `{` 之前只有 `):`，冇 `)` 之後嘅 `{`……
   *     ⚠️ 其實 `)` 一定出現（參數列）⇒ 呢個判別唔夠。
   *
   * ✅ 更可靠嘅做法：型別標註一定喺**同一個 `)` 之後**、而且型別標註之後
   *    一定仲有一個 `{`。所以：搵最後一個「`{` 之後（到結尾）再冇 `;` 或 `=`」
   *    太複雜 —— 改為**由 marker 之後全部 `{` 都試一次**，
   *    揀第一個「對應嘅 `}` 之後係 `)` 或 `=>` 尾或 `}`」嘅。
   *
   * 實務上最簡單可靠：搵 marker 之後**最後**一個「喺同一行有 `)` 或 `=>` 之前」嘅 `{`。
   * 下面用一個極簡但足夠嘅規則：跳過所有緊接 `:` 之後嘅 `{ ... }`（型別），
   * 然後取之下一個 `{`。
   */
  let i = idx + marker.length;
  // 跳過參數列
  const paren = src.indexOf("(", i);
  const brace = src.indexOf("{", i);
  if (paren >= 0 && (brace < 0 || paren < brace)) {
    let depth = 0;
    for (i = paren; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
  }
  // 由 `)` 之後，跳過任何型別標註：`: <字元> { ... }`（型別內冇 `;`／`=`）
  for (;;) {
    const rest = src.slice(i);
    const m = /^\s*:\s*([^{;=]*?)\{/.exec(rest);
    if (!m) break;
    // 跳到呢個 `{` 對應嘅 `}`，然後再試下一個（可能係 `Promise<{a}> {`）
    let j = i + m[0].length - 1;
    let depth = 0;
    for (; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    // 型別後面必須仍然係 `{`（真正主體）；否則呢個 `{` 就係主體本身
    const nextBrace = src.indexOf("{", j);
    if (nextBrace < 0) break;
    i = j;
  }
  i = src.indexOf("{", i);
  if (i < 0 || src[i] !== "{") return null;

  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

const PLAN = "src/lib/image-compress-plan.ts";
const COMPRESS = "src/lib/image-compress.ts";
const PHOTOS_API = "src/app/api/inventory/receipt-photos/route.ts";
const URL_API = "src/app/api/inventory/receipt-photos/url/route.ts";
const RECEIPT_EDIT = "src/app/api/inventory/receipts/[id]/route.ts";
const RECEIPT_LIST = "src/app/api/inventory/receipts/route.ts";
const EXPENSE_INV = "src/lib/expense-inventory.ts";
const VIEW = "src/components/inventory/inventory-view.tsx";

/**
 * 抽 `RECEIPT_EDIT` 嘅 DELETE 主體。
 *
 * 🔴 唔可以用 `bodyAfter(src, "export async function DELETE")`：
 *    嗰個檔有兩個 export（PATCH 同 DELETE），而 PATCH 先出現；
 *    加上簽名係 `DELETE(request: Request, context: { params: ... })` ——
 *    型別標註入面有個 `{`，跳型別嘅 regex 會停喺 `{ params: ... }`。
 *    ⇒ 由「最後一個 DELETE 宣告」開始，並跳過到函式主體 `{`。
 */
function receiptDeleteBody(src: string): string {
  const idx = src.lastIndexOf("export async function DELETE");
  assert.ok(idx >= 0, "搵唔到 DELETE");
  const m = /^export async function DELETE[\s\S]*?\)\s*\{/.exec(src.slice(idx));
  assert.ok(m, "攞唔到 DELETE 主體起點");
  const start = idx + m![0].length - 1;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

// ─────────────────────────────────────────────────────────────
// ① 200KB 硬要求
// ─────────────────────────────────────────────────────────────

test("① 壓縮方案定義 200KB 上限（1024 進位）", () => {
  const src = readSrc(PLAN);
  assert.match(src, /MAX_UPLOAD_BYTES\s*=\s*200\s*\*\s*1024/);
});

test("① 有品質階梯同縮邊階梯（逐級降，唔係壓一次就算）", () => {
  const src = readSrc(PLAN);
  assert.match(src, /QUALITY_LADDER/);
  assert.match(src, /EDGE_LADDER/);
  assert.match(src, /export function buildCompressPlan/);
  assert.match(src, /export function isWithinLimit/);
  assert.match(src, /export function rejectReason/);
});

test("① 達標判斷用 strict <（「200kb 以下」唔包括 200KB 本身）", () => {
  const src = readSrc(PLAN);
  /*
   * ⚠️ 呢度刻意**唔用 `bodyAfter()`**：`isWithinLimit` 簽名係
   *    `(bytes: number, limit: number = MAX_UPLOAD_BYTES): boolean {` ——
   *    型別標註同主體之間只有 `:` 加一個字，用通用跳型別邏輯好易抓錯。
   *    呢條斷言只關心兩個相鄰 token，直接睇原文更穩。
   */
  assert.match(src, /return bytes < limit;/, "必須用 strict < 而唔係 <=");
  assert.ok(!/return bytes <= limit;/.test(src), "唔可以用 <=（會放行剛好 200KB）");
});

test("① 壓縮器會走完階梯重試，唔係壓一次就算", () => {
  const src = readSrc(COMPRESS);
  assert.match(src, /buildCompressPlan\(/, "必須用方案階梯");
  assert.match(src, /for\s*\(\s*let i\s*=\s*0;\s*i\s*<\s*plan\.length/, "必須逐級迴圈");
  assert.match(src, /isWithinLimit\(/, "每級都要驗大小");
});

test("🔴 ① 壓縮走完階梯都唔達標 ⇒ 回 ok:false（唔可以照上傳原圖）", () => {
  const src = readSrc(COMPRESS);
  const body = bodyAfter(src, "export async function compressImage");
  assert.ok(body, "搵唔到 compressImage 主體");
  assert.match(body!, /ok:\s*false/, "超標必須回 ok:false");
  assert.match(body!, /rejectReason\(/, "超標要走最後把關砌原因");
});

test("🔴 ① 壓縮器唔可以「回原 file」當 fallback", () => {
  const src = readSrc(COMPRESS);
  // 若任何路徑回傳未壓縮嘅原檔，200KB 要求形同虛設。
  assert.ok(!/return\s*\{[^}]*ok:\s*true[^}]*file\s*[,}]/.test(src), "唔可以回原 file");
});

test("🔴 ① 上傳端點自己再驗一次大小（前端可以被繞過）", () => {
  const src = readSrc(PHOTOS_API);
  assert.match(src, /MAX_BYTES\s*=\s*200\s*\*\s*1024/);
  const body = bodyAfter(src, "export async function POST");
  assert.ok(body, "搵唔到 POST 主體");
  assert.match(body!, /file\.size\s*>=\s*MAX_BYTES/, "必須再驗一次（>= 因為係「以下」）");
  assert.match(body!, /413/, "超過大小應該回 413");
});

test("① 上傳端點只收圖片 MIME", () => {
  const src = readSrc(PHOTOS_API);
  assert.match(src, /ALLOWED_MIME/);
  assert.match(src, /415/);
});

// ─────────────────────────────────────────────────────────────
// ② private bucket ⇒ 一定要 signed URL
// ─────────────────────────────────────────────────────────────

test("② bucket 係 private（唔可以設 public）", () => {
  /*
   * 🔴 唔可以讀 `docs/...`：`SRC` 係 `new URL("../../", import.meta.url)`，
   *    由 `src/lib/` 上一兩層係 repo root，但 `readFileSync(URL)` 對
   *    **漢堡包路徑**（含 `docs/` 段）解析出錯（實測變成 `C:\dev\docs\...`）。
   *    ⇒ 改為由 `process.cwd()` 讀（`node --test` 一定喺 repo root 跑）。
   */
  const plan = readFileSync("docs/inventory-four-changes-plan-2026-10-07.md", "utf8");
  assert.match(plan, /'receipt-photos'\s*,\s*'receipt-photos'\s*,\s*false/, "bucket 必須 private");
});

test("② 有 signed URL 端點，用 createSignedUrl（唔係 getPublicUrl）", () => {
  const src = readSrc(URL_API);
  assert.match(src, /createSignedUrl\(/);
  assert.ok(!/getPublicUrl\(/.test(src), "private bucket 唔可以用 getPublicUrl");
  assert.match(src, /EXPIRES_IN/, "signed URL 必須有 TTL");
});

test("🔴 ② 簽名只限本店前綴（service_role 唔受 RLS，唔擋就係跨店外洩）", () => {
  const src = readSrc(URL_API);
  const body = bodyAfter(src, "export async function GET");
  assert.ok(body, "搵唔到 GET 主體");
  assert.match(body!, /startsWith\(/, "必須過濾 userId 前綴");
});

test("🔴 ② 前端唔可以直接用 path 做 img src（一定會 403）", () => {
  const src = stripComments(readSrc(VIEW));
  // 應該係 signed URL（`urls[p]` / `url`）而唔係 `r.photo_paths[i]` 直接入 src。
  assert.ok(
    !/<img[^>]*src=\{\s*p\s*\}/.test(src),
    "唔可以直接 <img src={p}>（p 係 Storage path）",
  );
  assert.match(src, /useSignedPhotoUrls/, "必須有簽名 hook");
});

test("② 簽名 hook 用字串 key 做 deps（陣列 identity 每次都變 ⇒ 無限請求）", () => {
  const src = stripComments(readSrc(VIEW));
  const idx = src.indexOf("function useSignedPhotoUrls");
  assert.ok(idx >= 0, "搵唔到 useSignedPhotoUrls");
  const tail = src.slice(idx);
  const m = /\}\s*,\s*\[([^\]]*)\]\s*\)/.exec(tail);
  assert.ok(m, "攞唔到 deps 陣列");
  const deps = m![1];
  assert.ok(!/\bpaths\b/.test(deps), `deps 唔可以直接用 paths 陣列：${deps}`);
  assert.match(deps, /key/, `deps 應該用 key 字串：${deps}`);
});

// ─────────────────────────────────────────────────────────────
// ③ 三態語意：!== undefined
// ─────────────────────────────────────────────────────────────

test("🔴 ③ PATCH 用 !== undefined 判斷 photo_paths", () => {
  const src = readSrc(RECEIPT_EDIT);
  assert.match(
    src,
    /body\.photo_paths\s*!==\s*undefined/,
    "必須用 !== undefined（空陣列 = 主動刪光，係有效指令）",
  );
});

test("🔴 ③ PATCH 唔可以用 truthiness 判斷 photo_paths（[] 會靜默失效）", () => {
  const src = stripComments(readSrc(RECEIPT_EDIT));
  assert.ok(
    !/if\s*\(\s*body\.photo_paths\s*\)/.test(src),
    "if (body.photo_paths) 會令「刪光相片」靜默失效",
  );
});

test("③ 清洗函式保留空陣列語意（唔可以回 null／undefined）", () => {
  const src = readSrc(EXPENSE_INV);
  assert.match(src, /export function sanitizePhotoPaths/);
  const body = bodyAfter(src, "export function sanitizePhotoPaths");
  assert.ok(body, "搵唔到 sanitizePhotoPaths 主體");
  assert.match(body!, /return out;/, "空陣列要原樣回（唔可以回 null）");
});

test("③ 清洗會擋路徑穿越（..／絕對路徑）", () => {
  const src = readSrc(EXPENSE_INV);
  const body = bodyAfter(src, "export function sanitizePhotoPaths");
  assert.ok(body, "搵唔到 sanitizePhotoPaths 主體");
  assert.match(body!, /includes\("\.\."\)/, "必須擋 ..");
  assert.match(body!, /startsWith\("\/"\)/, "必須擋絕對路徑");
});

test("③ 前端儲存時**一定**傳 photo_paths（唔傳 = 刪相失效）", () => {
  const src = stripComments(readSrc(VIEW));
  assert.match(src, /photo_paths:\s*photoPaths/, "payload 必須帶 photo_paths");
});

test("③ 前端合併「已存 path ＋ 新上傳 path」", () => {
  const src = stripComments(readSrc(VIEW));
  assert.match(src, /\[\s*\.\.\.form\.photo_paths\s*,\s*\.\.\.upload\.paths\s*\]/);
});

// ─────────────────────────────────────────────────────────────
// ④ 刪收據一併刪相
// ─────────────────────────────────────────────────────────────

test("🔴 ④ 刪收據會一併刪 Storage 相片", () => {
  const body = receiptDeleteBody(readSrc(RECEIPT_EDIT));
  assert.match(body, /storage\.from\(/, "必須呼叫 Storage 刪檔");
  assert.match(body, /\.remove\(/, "必須 remove");
  assert.match(body, /sanitizePhotoPaths\(/, "刪之前要讀返相片路徑");
});

test("🔴 ④ 一定要先讀路徑、後刪 row（刪完 row 就攞唔返）", () => {
  const body = receiptDeleteBody(readSrc(RECEIPT_EDIT));
  const readAt = body.indexOf("sanitizePhotoPaths(");
  const delAt = body.indexOf('.from("receipts").delete()');
  assert.ok(readAt >= 0 && delAt >= 0, "兩個動作都要存在");
  assert.ok(readAt < delAt, "必須先讀路徑再刪 receipt row");
});

test("🔴 ④ 刪檔失敗唔可以令「刪收據」失敗（Storage 錯只記錄）", () => {
  const body = receiptDeleteBody(readSrc(RECEIPT_EDIT));
  const rmAt = body.indexOf(".remove(");
  assert.ok(rmAt >= 0, "搵唔到 remove 呼叫");
  const after = body.slice(rmAt);
  assert.ok(
    !/NextResponse\.json\(\s*\{\s*ok:\s*false/.test(after),
    "刪檔之後唔應該再回 ok:false（否則商家見到「刪除失敗」但收據其實已刪）",
  );
  assert.match(after, /console\.warn/, "刪檔失敗應該只記錄");
});

test("④ 刪相只限本店前綴（defense in depth）", () => {
  const body = receiptDeleteBody(readSrc(RECEIPT_EDIT));
  assert.match(body, /startsWith\(/, "必須過濾 userId 前綴");
});

test("④ 獨立刪相端點亦只刪本店前綴", () => {
  const src = readSrc(PHOTOS_API);
  const body = bodyAfter(src, "export async function DELETE");
  assert.ok(body, "搵唔到 DELETE 主體");
  assert.match(body!, /startsWith\(/, "必須過濾 userId 前綴");
});

// ─────────────────────────────────────────────────────────────
// ⑤ 失敗唔阻擋儲存
// ─────────────────────────────────────────────────────────────

test("🔴 ⑤ 上傳失敗只回 {paths, failed}，唔會 throw／return 中斷", () => {
  const src = stripComments(readSrc(VIEW));
  const body = bodyAfter(src, "const uploadPendingPhotos = async");
  assert.ok(body, "搵唔到 uploadPendingPhotos 主體");
  assert.match(body!, /return\s*\{\s*paths\s*,\s*failed\s*\}/, "必須回 { paths, failed }");
  // catch 之後唔可以 rethrow
  assert.ok(!/throw\s/.test(body!), "唔可以 throw（會中斷儲存流程）");
});

test("🔴 ⑤ save() 收到上傳結果後仍然繼續儲存（唔可以 early return）", () => {
  const src = stripComments(readSrc(VIEW));
  assert.match(src, /const upload = await uploadPendingPhotos\(\)/);
  assert.match(src, /const failedPhotoCount = upload\.failed/);
  // 緊接 failedPhotoCount 之後唔可以有 `return`（即「有失敗就唔存」）
  const idx = src.indexOf("const failedPhotoCount = upload.failed");
  const after = src.slice(idx, idx + 400);
  assert.ok(!/^\s*if\s*\([^)]*failedPhotoCount[^)]*\)\s*return/m.test(after), "唔可以因為相片失敗而唔存收據");
});

test("⑤ 相片失敗時會明確通知商家（唔可以靜默）", () => {
  const src = stripComments(readSrc(VIEW));
  assert.match(src, /failedPhotoCount\s*>\s*0/, "要有失敗提示分支");
  assert.match(src, /收據已儲存/, "提示要講清楚收據已經存到");
});

test("⑤ 相片係選填：modal 唔會當必填", () => {
  const src = stripComments(readSrc(VIEW));
  const body = bodyAfter(src, "const save = async");
  assert.ok(body, "搵唔到 save 主體");
  assert.ok(
    !/photo_paths\.length\s*===\s*0[^)]*\)\s*return\s*setErr/.test(body!),
    "唔可以因為冇相片而 setErr",
  );
  assert.match(src, /（選填）/, "UI 要標明選填");
});

// ─────────────────────────────────────────────────────────────
// UI／輸入細節
// ─────────────────────────────────────────────────────────────

test("🔴 file input 唔可以加 capture（會令 iOS 跳過「選相片」）", () => {
  const src = readSrc(VIEW);
  // 只檢查 file input 嘅屬性區，避免誤中其他字。
  const m = /<input[\s\S]{0,600}?type="file"[\s\S]{0,600}?\/>/.exec(src);
  assert.ok(m, "搵唔到 file input");
  assert.ok(!/capture=/.test(m![0]), "唔可以加 capture（iPad 會直接開相機、冇得揀圖庫）");
  assert.match(m![0], /accept="image\/\*"/, "要限定圖片");
  assert.match(m![0], /multiple/, "要支援多張");
});

test("🔴 揀完相要清 input.value（否則同一張相揀第二次唔觸發）", () => {
  const src = stripComments(readSrc(VIEW));
  const body = bodyAfter(src, "const handlePhotoPick = async");
  assert.ok(body, "搵唔到 handlePhotoPick 主體");
  assert.match(body!, /photoInputRef\.current\.value\s*=\s*""/, "要清空 value");
});

test("🔴 開 modal 要清相片狀態（否則上一張單嘅相會跟去下一張）", () => {
  const src = stripComments(readSrc(VIEW));
  const idx = src.indexOf("setPendingPhotos((prev) =>");
  assert.ok(idx >= 0, "開 modal 時要清 pendingPhotos");
  // 順便要釋放 objectURL
  assert.match(src.slice(idx, idx + 300), /revokeObjectURL/, "要釋放 objectURL");
});

test("🔴 移除時要 revokeObjectURL（iPad Safari 記憶體緊）", () => {
  const src = readSrc(VIEW);
  const body = bodyAfter(src, "const removePendingPhoto =");
  assert.ok(body, "搵唔到 removePendingPhoto 主體");
  assert.match(body!, /revokeObjectURL/);
});

test("🔴 壓縮用 createImageBitmap（自動套 EXIF 方向）", () => {
  const src = readSrc(COMPRESS);
  assert.match(src, /createImageBitmap\(/, "要用 createImageBitmap 處理 EXIF");
});

test("🔴 canvas 要填白底（PNG 透明轉 JPEG 會變黑，黑底黑字睇唔到）", () => {
  const src = readSrc(COMPRESS);
  assert.match(src, /fillStyle\s*=\s*"#ffffff"/, "要填白底");
  /*
   * ⚠️ 同樣唔用 `bodyAfter()`（`renderJpeg` 簽名跨五行、型別係 `Promise<Blob | null>`）。
   *    改用「由函式起點到 `toBlob` 之間，`fillRect` 要早過 `drawImage`」——
   *    呢個範圍一定包含兩者，而且唔受型別影響。
   */
  const from = src.indexOf("async function renderJpeg");
  const to = src.indexOf("toBlob(", from);
  assert.ok(from >= 0 && to > from, "搵唔到 renderJpeg 範圍");
  /*
   * 🔴 一定要 `stripComments()`：填白底上面嘅註解寫住「一定要喺 drawImage **之前**填」，
   *    唔剝註解就會喺 445 位置命中嗰個字串，而 `fillRect` 喺 505 ⇒
   *    報一個「填白底喺 drawImage 之後」嘅**假 failure**（P3 首次跑實測中過）。
   */
  const body = stripComments(src.slice(from, to));
  const fillAt = body.indexOf("fillRect");
  const drawAt = body.indexOf("drawImage");
  assert.ok(fillAt >= 0 && drawAt >= 0, "兩個動作都要存在");
  assert.ok(fillAt < drawAt, "填白底一定要喺 drawImage 之前");
});

test("🔴 縮圖唔可以縮到 0 高（canvas 尺寸 0 ⇒ toBlob 回 null）", () => {
  const src = readSrc(PLAN);
  const body = bodyAfter(src, "export function fitWithin");
  assert.ok(body, "搵唔到 fitWithin 主體");
  assert.match(body!, /Math\.max\(1,/, "尺寸要有 1px 下限");
});

test("🔴 縮圖唔可以縮到 0 高（canvas 尺寸 0 ⇒ toBlob 回 null）", () => {
  const src = readSrc(PLAN);
  const body = bodyAfter(src, "export function fitWithin");
  assert.ok(body, "搵唔到 fitWithin 主體");
  assert.match(body!, /Math\.max\(1,/, "尺寸要有 1px 下限");
});

test("壓縮完要 close() ImageBitmap（唔係會佔住幾十 MB）", () => {
  const src = readSrc(COMPRESS);
  assert.match(src, /\.close\(\)/, "要 close ImageBitmap");
});

test("modal 內有上傳按鈕同待上傳預覽", () => {
  /*
   * 🔴 呢幾條字串係 **JSX 文字**（唔喺註解入面），所以可以喺原檔搵；
   *    但「清單只標相片數」嗰條要搵 `r.photo_paths!.length`，
   *    `!` 會被 stripComments 保留（唔係註解），所以直接用原檔。
   */
  const src = readSrc(VIEW);
  assert.match(src, /上傳單據照片/, "要有上傳按鈕");
  assert.match(src, /待上傳/, "要有待上傳區塊");
  assert.match(src, /儲存時自動上傳/, "要講清楚幾時上傳");
});

test("清單只標相片數、唔逐張簽 URL（簽名係貴操作）", () => {
  const src = readSrc(VIEW);
  assert.match(src, /photo_paths\?\.length\s*\?\?\s*0\)\s*>\s*0/, "清單要出相片數標記");
  // 收據卡片區（由「收據清單」到該 section 結尾）唔應該有 StoredPhotoStrip
  const listIdx = src.indexOf("收據清單");
  assert.ok(listIdx >= 0, "搵唔到收據清單區塊");
  const cardEnd = src.indexOf("</section>", listIdx);
  assert.ok(cardEnd > listIdx, "搵唔到 section 結尾");
  const card = src.slice(listIdx, cardEnd);
  assert.ok(!/StoredPhotoStrip/.test(card), "清單卡片唔應該渲染縮圖（會逐張簽 URL）");
});
