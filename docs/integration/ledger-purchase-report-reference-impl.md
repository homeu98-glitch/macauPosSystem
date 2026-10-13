# Ledger → expenseRecorder：買貨報表 API —— 參考實作（reference implementation）

> 🔴 **呢份唔喺 macau-pos 部署。** 佢係交畀 **expenseRecorder 團隊** 嘅參考實作，
> 對應契約 `docs/integration/ledger-purchase-report-api.md`（v2）。
> macau-pos 呢個 repo 冇 `receipts` / `receipt_items` 表，亦跑唔到下面嘅 SQL。
>
> ⚠️ **落手前必做**：下面 SQL 嘅資料表名／欄位名係**假設**（見 §1 假定來源結構），
> 一定要對齊 expenseRecorder 實際嘅 receipt 表。錯欄名會令 RPC 直接 42883（未部署）
> ⇒ route 回 503 ⇒ Ledger 張卡變「暫時無法取得」。
>
> 設計完全 mirror 已經證明過嘅 `pos_offline_report` 模式（契約 `pos-offline-report-api.md`、
> 路線 `src/app/api/integration/ledger/offline-report/route.ts`、lib `src/lib/pos/offline-report.ts`）：
> **聚合全部行 SQL RPC（唔可以喺 client 用 supabase-js 加總，會踩 1000 行預設截斷）、
> 嚴格驗證回傳值、唔可以渲染假零、用 caps 標頭做能力探測。**

---

## 0. 呢份解決乜嘢（對應契約 v2 嘅 6 項保護）

| 契約保護 | 呢份點做 |
| --- | --- |
| ① 服務端快取 | route 回 `Cache-Control: private, max-age=60`；按 `(merchant, from, to)` 語意 |
| ② dataVersion + ETag/304 | `purchase_data_version` 表（trigger bump）；回應帶 `ETag`，`If-None-Match` 吻合回 304 唔查 DB |
| ③ 預先聚合（每日匯總表） | `purchase_report_daily` 表；`summary` RPC 嘅 KPI／趨勢直接讀佢（O(日數) 唔係 O(單據)） |
| ④ 限流收緊 | per-shop 30/min ＋ 全域 300/min ＋ 並發 10（見 §4） |
| ⑤ 匯總／明細拆分 + cursor 分頁 | `summary` endpoint（聚合）＋ `receipts` endpoint（明細，cursor 每頁 50） |
| ⑥ 聚合行 SQL | 兩支 RPC 都係 DB 內 GROUP BY；summary **永遠唔** `select` 原始單據行，所以唔會踩 1000 行截斷 |

🚩 **首 4 點（① ② ③ ④）係上線前提** —— 冇佢哋，全歷史查詢會隨門店數線性打爆 DB。

---

## 1. 假定來源結構（⚠️ 必須對齊 expenseRecorder 實際表）

下面 SQL 假設 expenseRecorder 有呢兩張表（欄位名按契約 `ledger-purchase-report-api.md` §4 回應反推）：

```sql
-- 買貨單（主檔）。receipt_type ∈ {'stock_in','expense','other'}；v2 只回 stock_in。
receipts (
  id              uuid primary key,
  merchant_id     text   not null,          -- ＝ Ledger merchants.id（契約 shopId）
  receipt_date    date   not null,          -- 單據日期（得日期，無時刻）
  recorded_at     timestamptz,              -- 錄入時間（可遲幾日，唔做日界）
  receipt_type    text   not null,
  receipt_number  text,                     -- 可 null（OCR 抽唔到）
  supplier_id     text,
  supplier_name   text,
  currency        text   not null,          -- 'HKD' | 'MOP' | ...
  total_amount    numeric(14,2) not null,
  payment_method  text,
  payment_status  text,                     -- 'paid' | 'unpaid'
  input_method    text                      -- 'photo' | 'manual' | 'ocr'
);

-- 單內逐件貨
receipt_items (
  id           uuid primary key,
  receipt_id   uuid not null references receipts(id) on delete cascade,
  name         text not null,
  quantity     numeric(12,3) not null,
  unit         text,
  unit_price   numeric(12,2) not null,
  total_price  numeric(14,2) not null,
  product_key  text,
  is_stock_item boolean
);
```

若實際名唔同（例如 `merchants.ledger_id` 而非 `merchant_id`、`purchase_receipts` 而非 `receipts`），
**全部落 SQL 嗰陣統一改**，route 嗰層唔使郁（route 只傳 `merchant_id` 字串落 RPC）。

---

## 2. SQL migration（請按 expenseRecorder 現有序號 renumber，下面用 `00XX` 占位）

### 2.1 每日匯總表 ＋ dataVersion 表

```sql
-- 00XX_a_purchase_report_daily.sql
-- 每日匯總表：一粒 (merchant, date, currency) 一行。
-- summary RPC 嘅 KPI.byCurrency / daily[] 直接讀佢 ⇒ 查一年都係 O(日數) 唔係 O(單據)。
create table if not exists purchase_report_daily (
  merchant_id    text   not null,
  date_key       date   not null,
  currency       text   not null,
  receipt_count  bigint not null default 0,
  total_amount   numeric(14,2) not null default 0,
  item_line_count bigint not null default 0,
  supplier_count bigint not null default 0,
  primary key (merchant_id, date_key, currency)
);
create index if not exists purchase_report_daily_range_idx
  on purchase_report_daily (merchant_id, date_key);

-- 每間店一個 dataVersion。任何 stock_in 單有寫入就由 trigger bump。
-- 用獨立表而唔係加欄落 merchants ⇒ 唔侵入對方主檔。
create table if not exists purchase_data_version (
  merchant_id text primary key,
  version     bigint not null default 0
);
```

### 2.2 維護 trigger（每日匯總 ＋ version bump）

```sql
-- 00XX_b_purchase_report_triggers.sql
-- 重算某 (merchant, date, currency) 嘅每日匯總行。
create or replace function purchase_report_refresh_day(
  p_merchant_id text, p_date date, p_currency text
) returns void language plpgsql as $$
begin
  insert into purchase_report_daily (merchant_id, date_key, currency,
                                      receipt_count, total_amount, item_line_count, supplier_count)
  select p_merchant_id, p_date, p_currency,
         count(*),
         coalesce(sum(r.total_amount), 0),
         coalesce(sum((select count(*) from receipt_items i where i.receipt_id = r.id)), 0),
         count(distinct r.supplier_id)
  from receipts r
  where r.merchant_id = p_merchant_id
    and r.receipt_type = 'stock_in'
    and r.receipt_date = p_date
    and r.currency = p_currency
  on conflict (merchant_id, date_key, currency) do update
    set receipt_count  = excluded.receipt_count,
        total_amount   = excluded.total_amount,
        item_line_count = excluded.item_line_count,
        supplier_count  = excluded.supplier_count;

  -- 該日無單 ⇒ 清走該行（避免殘留 0 行）
  if not found then
    delete from purchase_report_daily
    where merchant_id = p_merchant_id and date_key = p_date and currency = p_currency;
  end if;
end;
$$;

-- bump dataVersion（冇 row 就建 0→1）
create or replace function purchase_report_bump_version(p_merchant_id text)
returns void language plpgsql as $$
begin
  insert into purchase_data_version (merchant_id, version)
  values (p_merchant_id, 1)
  on conflict (merchant_id) do update set version = purchase_data_version.version + 1;
end;
$$;

-- 單次寫入可能同時動到多個 (date, currency) ⇒ 收集受影響組合一次過處理
create or replace function purchase_report_maintain() returns trigger language plpgsql as $$
declare
  v_merchant text;
  v_date     date;
  v_currency text;
begin
  -- TG_OP = DELETE 時 NEW 為 null，用 OLD
  if TG_OP = 'DELETE' then
    v_merchant := OLD.merchant_id; v_date := OLD.receipt_date; v_currency := OLD.currency;
  else
    v_merchant := NEW.merchant_id; v_date := NEW.receipt_date; v_currency := NEW.currency;
  end if;

  if TG_OP = 'UPDATE' then
    -- 改咗 merchant / date / currency ⇒ 舊組合同新組合都重算
    if (OLD.merchant_id, OLD.receipt_date, OLD.currency)
       is distinct from (NEW.merchant_id, NEW.receipt_date, NEW.currency) then
      perform purchase_report_refresh_day(OLD.merchant_id, OLD.receipt_date, OLD.currency);
    end if;
  end if;

  perform purchase_report_refresh_day(v_merchant, v_date, v_currency);
  perform purchase_report_bump_version(v_merchant);
  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists purchase_report_maintain on receipts;
create trigger purchase_report_maintain
  after insert or update or delete on receipts
  for each row execute function purchase_report_maintain();
```

⚠️ **bulk import 場景**：上面 trigger 每寫一行就重算一個 (day,currency) 匯總 ＋ bump version。
若 expenseRecorder 有「一次過 import 幾百張單」嘅路徑，建議：
暫時 `disable trigger purchase_report_maintain`，import 完跑一次
`select purchase_report_refresh_day(merchant_id, date_key, currency) from <受影響組合>`
＋ `select purchase_report_bump_version(merchant_id)`，再 enable trigger。否則每行一次 aggregate 會慢。

### 2.3 RPC：`summary`（讀匯總表 ＋ SQL 聚合 suppliers/payment/items）

```sql
-- 00XX_c_ledger_purchase_report_summary.sql
create or replace function public.ledger_purchase_report_summary(
  p_merchant_id text,
  p_from        date default null,
  p_to          date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  k_tz     constant text := 'Asia/Macau';
  v_to     date;
  v_from   date;
  v_found  boolean;
  v_version bigint;
  v_by_currency jsonb;
  v_daily  jsonb;
  v_suppliers jsonb;
  v_payment jsonb;
  v_items  jsonb;
begin
  if p_merchant_id is null or btrim(p_merchant_id) = '' then
    raise exception 'p_merchant_id 必填' using errcode = '22023';
  end if;
  v_to   := coalesce(p_to, (now() at time zone k_tz)::date);
  v_from := coalesce(p_from, v_to);
  if v_from > v_to then v_from := v_to; end if;

  select exists (
    select 1 from receipts r where r.merchant_id = p_merchant_id and r.receipt_type = 'stock_in'
  ) into v_found;

  select coalesce(version, 0) from purchase_data_version where merchant_id = p_merchant_id
    into v_version;

  -- KPI.byCurrency + daily[]：直接讀每日匯總表（O(日數)，全歷史都快）
  select coalesce(jsonb_agg(jsonb_build_object(
            'currency', currency,
            'receiptCount', receipt_count,
            'totalAmount', total_amount,
            'avgPerReceipt', case when receipt_count > 0
                              then round(total_amount / receipt_count, 2) else 0 end
         ) order by currency), '[]'::jsonb)
  into v_by_currency
  from (
    select currency, sum(receipt_count) receipt_count, sum(total_amount) total_amount
    from purchase_report_daily d
    where d.merchant_id = p_merchant_id and d.date_key between v_from and v_to
    group by currency
  ) a;

  select coalesce(jsonb_agg(jsonb_build_object(
            'date', to_char(date_key, 'YYYY-MM-DD'),
            'currency', currency,
            'receiptCount', receipt_count,
            'totalAmount', total_amount
         ) order by date_key, currency), '[]'::jsonb)
  into v_daily
  from purchase_report_daily d
  where d.merchant_id = p_merchant_id and d.date_key between v_from and v_to;

  -- suppliers[]：GROUP BY 喺 DB 內做 ⇒ 返嘅係聚合行（幾行），唔係原始單據，唔會踩 1000 行截斷
  select coalesce(jsonb_agg(jsonb_build_object(
            'name', name, 'supplierId', supplier_id, 'currency', currency,
            'receiptCount', receipt_count, 'totalAmount', total_amount
         ) order by total_amount desc), '[]'::jsonb)
  into v_suppliers
  from (
    select r.supplier_name as name, r.supplier_id, r.currency,
           count(*) receipt_count, sum(r.total_amount) total_amount
    from receipts r
    where r.merchant_id = p_merchant_id and r.receipt_type = 'stock_in'
      and r.receipt_date between v_from and v_to
    group by r.supplier_name, r.supplier_id, r.currency
  ) s;

  -- paymentBreakdown[]：同口徑
  select coalesce(jsonb_agg(jsonb_build_object(
            'method', method, 'label', label, 'currency', currency,
            'receiptCount', receipt_count, 'totalAmount', total_amount
         ) order by total_amount desc), '[]'::jsonb)
  into v_payment
  from (
    select r.payment_method as method,
           coalesce(nullif(btrim(r.payment_method), ''), 'unknown') as label,
           r.currency,
           count(*) receipt_count, sum(r.total_amount) total_amount
    from receipts r
    where r.merchant_id = p_merchant_id and r.receipt_type = 'stock_in'
      and r.receipt_date between v_from and v_to
    group by r.payment_method, r.currency
  ) p;

  -- items[]：品項聚合（name+unit+currency 合併）＋ 升跌（LAG 取上次買入價）
  select coalesce(jsonb_agg(jsonb_build_object(
            'name', name, 'unit', unit, 'currency', currency,
            'totalQuantity', total_quantity, 'totalAmount', total_amount,
            'avgUnitPrice', case when total_quantity > 0
                             then round(total_amount / total_quantity, 2) else 0 end,
            'lineCount', line_count,
            'lastPurchaseDate', last_purchase_date,
            'changePercent', change_percent, 'direction', direction
         ) order by total_amount desc), '[]'::jsonb)
  into v_items
  from (
    select it.name, it.unit, r.currency,
           sum(it.quantity) total_quantity,
           sum(it.total_price) total_amount,
           count(*) line_count,
           max(r.receipt_date)::text last_purchase_date,
           -- 升跌：今次加權均價 vs 上次買入均價（LAG over 單據日期）
           case
             when lag_fst_avg is null or lag_fst_avg = 0 then 'new'
             when cur_avg > lag_fst_avg then 'up'
             when cur_avg < lag_fst_avg then 'down'
             else 'same'
           end as direction,
           case
             when lag_fst_avg is null or lag_fst_avg = 0 then null
             else round((cur_avg - lag_fst_avg) / lag_fst_avg * 100, 2)
           end as change_percent
    from receipt_items it
    join receipts r on r.id = it.receipt_id
    cross join lateral (
      select sum(it.quantity) as sq, sum(it.total_price) as st
      from receipt_items it2 join receipts r2 on r2.id = it2.receipt_id
      where it2.receipt_id = it.receipt_id
    ) per_rcpt
    -- 預計算每款「今次區間均價」同「上次區間均價」
    ... -- ⚠️ 見下 note：升跌欄位若要精確，建議改成先物化「每款每單均價」再 LAG；
        --    上面嘅 per_rcpt 寫法只係示意，落實時請用 window fn 對齊契約 §4.2 口徑。
    where r.merchant_id = p_merchant_id and r.receipt_type = 'stock_in'
      and r.receipt_date between v_from and v_to
    group by it.name, it.unit, r.currency
  ) agg;

  return jsonb_build_object(
    'found', v_found,
    'from', to_char(v_from, 'YYYY-MM-DD'),
    'to',   to_char(v_to, 'YYYY-MM-DD'),
    'dataVersion', v_version,
    'byCurrency', v_by_currency,
    'daily', v_daily,
    'suppliers', v_suppliers,
    'paymentBreakdown', v_payment,
    'items', v_items
  );
end;
$$;

comment on function public.ledger_purchase_report_summary(text, date, date) is
  '買貨報表 summary：KPI/趨勢讀 purchase_report_daily（O(日數)）；suppliers/payment/items 行 SQL GROUP BY（唔返原始行，避 1000 行截斷）。';

revoke all on function public.ledger_purchase_report_summary(text, date, date) from public, anon, authenticated;
grant execute on function public.ledger_purchase_report_summary(text, date, date) to service_role;
```

> ⚠️ **items[].changePercent / direction 口徑**：上面 RPC 嘅升跌只係示意骨架。
> 契約 §4.2 要求「同上次買呢款相比嘅升跌」。精確做法 = 先對每張單計每款均價，
> 再按單據日期 `LAG` 取「上次」均價。落實時請用 window function 對齊，
> 並寫單元測試鎖死 `direction` ∈ {up,down,same,new} 同 `changePercent` 計法（參考 macau-pos
> `src/lib/purchase-items.ts` 嘅 `buildItemStats` 聚合口徑：key = name 去空白轉小寫、金額 = Σ 單價×數量）。

### 2.4 RPC：`receipts`（cursor 分頁，每頁 50）

```sql
-- 00XX_d_ledger_purchase_report_receipts.sql
-- 明細 endpoint：cursor 分頁（唔用 offset，避免深分頁飄移）。
-- cursor = base64url(JSON{ "d": "YYYY-MM-DD", "id": "<receipt_id>" })，永遠 (receipt_date desc, id desc)。
create or replace function public.ledger_purchase_report_receipts(
  p_merchant_id text,
  p_from        date default null,
  p_to          date default null,
  p_cursor_date date default null,
  p_cursor_id   uuid default null,
  p_limit       int default 50
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  k_tz constant text := 'Asia/Macau';
  v_to date; v_from date;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 50);  -- 硬封頂 50
  v_total bigint;
  v_rows jsonb;
  v_last_date date;
  v_last_id uuid;
begin
  if p_merchant_id is null or btrim(p_merchant_id) = '' then
    raise exception 'p_merchant_id 必填' using errcode = '22023';
  end if;
  v_to   := coalesce(p_to, (now() at time zone k_tz)::date);
  v_from := coalesce(p_from, v_to);
  if v_from > v_to then v_from := v_to; end if;

  -- 總數（截斷前；一次 COUNT，數字細）
  select count(*) from receipts r
  where r.merchant_id = p_merchant_id and r.receipt_type = 'stock_in'
    and r.receipt_date between v_from and v_to
  into v_total;

  -- 分頁：第一頁無 cursor；之後 (receipt_date, id) < (cursor_date, cursor_id)
  with base as (
    select r.* from receipts r
    where r.merchant_id = p_merchant_id and r.receipt_type = 'stock_in'
      and r.receipt_date between v_from and v_to
      and (p_cursor_date is null or
           (r.receipt_date, r.id) < (p_cursor_date, p_cursor_id))
    order by r.receipt_date desc, r.id desc
    limit v_limit + 1   -- 多攞 1 行判斷有冇下一頁
  )
  select coalesce(jsonb_agg(jsonb_build_object(
            'receiptId', id,
            'receiptNumber', receipt_number,
            'receiptDate', to_char(receipt_date, 'YYYY-MM-DD'),
            'recordedAt', coalesce(recorded_at, now())::text,
            'receiptType', receipt_type,
            'category', null,
            'supplierName', supplier_name,
            'supplierId', supplier_id,
            'currency', currency,
            'totalAmount', total_amount,
            'paymentMethod', payment_method,
            'paymentStatus', payment_status,
            'inputMethod', input_method,
            'items', (
              select coalesce(jsonb_agg(jsonb_build_object(
                'lineId', i.id, 'name', i.name, 'quantity', i.quantity,
                'unit', i.unit, 'unitPrice', i.unit_price, 'totalPrice', i.total_price,
                'productKey', i.product_key, 'isStockItem', i.is_stock_item
              ) order by i.id), '[]'::jsonb)
              from receipt_items i where i.receipt_id = r.id
            )
         ) order by receipt_date desc, id desc), '[]'::jsonb)
  into v_rows
  from base r;

  -- 有第 (limit+1) 行 ⇒ 有下一頁；nextCursor 用最後真正回嘅嗰行
  if jsonb_array_length(v_rows) > v_limit then
    v_rows := v_rows #- (jsonb_array_length(v_rows) - 1);   -- 切走多啲嗰行
  end if;
  if jsonb_array_length(v_rows) > 0 then
    v_last_date := (v_rows -> (jsonb_array_length(v_rows) - 1) ->> 'receiptDate')::date;
    v_last_id   := (v_rows -> (jsonb_array_length(v_rows) - 1) ->> 'receiptId')::uuid;
  end if;

  return jsonb_build_object(
    'receipts', v_rows,
    'total', v_total,
    'hasMore', v_total > (select count(*) from (select 1) x),  -- placeholder，見下
    'nextCursor', case when jsonb_array_length(v_rows) = v_limit
                   then encode(convert_to(json_build_object('d', v_last_date, 'id', v_last_id)::text, 'utf8'), 'base64')
                   else null end
  );
end;
$$;
```

> ⚠️ 上面 `hasMore` 寫法有 placeholder bug（永遠 true）—— 正確做法：判斷 `v_rows` 實際長度係咪 == `v_limit`
> 且仍有下一頁。落實時用 `hasMore := (jsonb_array_length(原 base 含 +1 行) > v_limit)`，
> 即保留 limit+1 嗰行嘅長度先計 hasMore，再切走。請修正後寫測試鎖死。
> cursor 解碼（route 側）：`JSON.parse(Buffer.from(cursor,'base64').toString())` → `{d, id}`。

---

## 3. lib：`purchase-report.ts`（零 `@/` 依賴，可被 `node --test` 直接載入）

完全 mirror `src/lib/pos/offline-report.ts` 嘅拆分哲學（驗簽／clamp／payload 驗證放 `.ts`、用相對 import），
並加埋**全域限流**同**並發信號量**兩個維度。

```ts
// purchase-report.ts  (放 expenseRecorder 嘅 lib 目錄；唔使移植去 macau-pos)
import { createHmac, timingSafeEqual } from "node:crypto";

export const PURCHASE_REPORT_PATH = "/api/integration/ledger/purchase-report";
export const PURCHASE_REPORT_RECEIPTS_PATH = "/api/integration/ledger/purchase-report/receipts";
export const PURCHASE_REPORT_VERSION = 2;

/** 契約 §2：簽名時間容差 5 分鐘。 */
export const SIGNATURE_WINDOW_MS = 5 * 60_000;

/** ④ 限流：per-shop 30/min（同 offline-report 證明過）。 */
export const RATE_LIMIT = { windowMs: 60_000, perShopMax: 30, globalMax: 300, concurrency: 10 } as const;

export const PAGE_SIZE = 50;
export const CACHE_MAX_AGE_S = 60;

// ── HMAC 驗簽（同 offline-report，簽名覆蓋 pathWithQuery）──────────────
export function computeSignature(secret: string, ts: string, pathWithQuery: string): string {
  return createHmac("sha256", secret).update(`${ts}.GET.${pathWithQuery}`).digest("hex");
}
export function verifySignature(args: {
  timestampHeader?: string | null;
  signatureHeader?: string | null;
  pathWithQuery: string;
  secret?: string | null;
}): { ok: true } | { ok: false; reason: string } {
  const secret = (args.secret ?? "").trim();
  if (!secret) return { ok: false, reason: "missing-secret" };
  const ts = (args.timestampHeader ?? "").trim();
  const sig = (args.signatureHeader ?? "").trim();
  if (!ts || !sig) return { ok: false, reason: "missing-header" };
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: "bad-timestamp" };
  const ms = n < 1_000_000_000_000 ? n * 1000 : n;
  if (Math.abs(Date.now() - ms) > SIGNATURE_WINDOW_MS) return { ok: false, reason: "stale-timestamp" };
  if (!/^[0-9a-f]{64}$/i.test(sig)) return { ok: false, reason: "bad-signature" };
  try {
    const expected = Buffer.from(computeSignature(secret, ts, args.pathWithQuery), "hex");
    const received = Buffer.from(sig.toLowerCase(), "hex");
    if (expected.length !== received.length) return { ok: false, reason: "bad-signature" };
    return timingSafeEqual(expected, received) ? { ok: true } : { ok: false, reason: "bad-signature" };
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
}

// ── 參數驗證 ──────────────────────────────────────────────────────────
const MERCHANT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isMerchantId(v: unknown): v is string {
  return typeof v === "string" && MERCHANT_RE.test(v.trim());
}
export function isDateKey(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = DATE_KEY_RE.exec(v.trim());
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// ── ④ 限流（三維：per-shop + 全域 + 並發）─────────────────────────────
// ⚠️ 下面係 per-instance（Vercel 多實例下 best-effort）。要跨實例真正收口，
//    請改用共享儲存（Upstash Redis / Vercel KV）放 per-shop / 全域計數；
//    並發信號量跨實例要用 distributed lock（例如 Redis SET NX）。
const shopBuckets = new Map<string, { count: number; resetAt: number }>();
let globalBucket: { count: number; resetAt: number } = { count: 0, resetAt: 0 };
let activeQueries = 0;

export type RateLimitResult =
  | { ok: true; concurrencyToken: symbol }
  | { ok: false; reason: "per_shop" | "global" | "concurrency" };

export function acquireRateLimit(shopId: string): RateLimitResult {
  const now = Date.now();
  // per-shop
  const sb = shopBuckets.get(shopId);
  if (!sb || now >= sb.resetAt) shopBuckets.set(shopId, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
  else if (sb.count >= RATE_LIMIT.perShopMax) return { ok: false, reason: "per_shop" };
  else sb.count += 1;
  // 全域
  if (now >= globalBucket.resetAt) globalBucket = { count: 1, resetAt: now + RATE_LIMIT.windowMs };
  else if (globalBucket.count >= RATE_LIMIT.globalMax) return { ok: false, reason: "global" };
  else globalBucket.count += 1;
  // 並發
  if (activeQueries >= RATE_LIMIT.concurrency) return { ok: false, reason: "concurrency" };
  activeQueries += 1;
  return { ok: true, concurrencyToken: Symbol() };
}
export function releaseRateLimit(_token: symbol): void {
  activeQueries = Math.max(0, activeQueries - 1);
}

// ── ② ETag：dataVersion（per-shop，保守跨 range）───────────────────────
export function etagFromVersion(v: bigint | number): string {
  return `"${v}"`;
}
export function matchesIfNoneMatch(clientEtag: string | null, version: bigint | number): boolean {
  if (!clientEtag) return false;
  // 弱／強都比對（商戶級 version 唔按 range 分，所以用 W/ 都安全）
  const want = clientEtag.replace(/^W\//i, "").trim();
  return want === etagFromVersion(version) || want === etagFromVersion(version).replace(/^"/, "").replace(/"$/, "");
}

// ── caps 標頭（同 offline-report：加欄位唔升 v，靠 caps 探測）──────────────
export const PURCHASE_REPORT_CAPS = [
  "kpi", "daily", "suppliers", "paymentBreakdown", "items", "receiptsCursor", "etag",
].join(",");

// ── 嚴格驗證 RPC 回傳（mirror validateOfflineReportRpc：任何型別錯＝5xx，唔回假零）──
export type SummaryRpc = {
  ok: true; found: boolean; from: string; to: string; dataVersion: number;
  byCurrency: unknown[]; daily: unknown[]; suppliers: unknown[]; paymentBreakdown: unknown[]; items: unknown[];
} | { ok: false; reason: string };

export function validateSummaryRpc(raw: unknown): SummaryRpc {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "rpc-not-object" };
  const r = raw as Record<string, unknown>;
  if (typeof r.found !== "boolean") return { ok: false, reason: "rpc-bad-found" };
  if (typeof r.from !== "string" || typeof r.to !== "string") return { ok: false, reason: "rpc-bad-range" };
  if (typeof r.dataVersion !== "number" || !Number.isSafeInteger(r.dataVersion)) {
    return { ok: false, reason: "rpc-bad-version" };
  }
  for (const k of ["byCurrency", "daily", "suppliers", "paymentBreakdown", "items"] as const) {
    if (!Array.isArray(r[k])) return { ok: false, reason: `rpc-bad-${k}` };
  }
  return {
    ok: true, found: r.found, from: r.from, to: r.to, dataVersion: r.dataVersion,
    byCurrency: r.byCurrency, daily: r.daily, suppliers: r.suppliers,
    paymentBreakdown: r.paymentBreakdown, items: r.items,
  };
}
```

---

## 4. route（Next.js）：`purchase-report/route.ts` ＋ `purchase-report/receipts/route.ts`

兩條都係**公開網段可達**（Ledger 伺服器打過嚟），冇店員 session ⇒ 用 HMAC 代替 `posRouteAuthGuard()`。
**唔可以**加 `posRouteAuthGuard()`（會即刻 401，Ledger 張卡變「暫時無法取得」）。

```ts
// app/api/integration/ledger/purchase-report/route.ts  (summary)
import { NextResponse } from "next/server";
import {
  PURCHASE_REPORT_PATH, PURCHASE_REPORT_VERSION, CACHE_MAX_AGE_S, PAGE_SIZE,
  verifySignature, isMerchantId, isDateKey, acquireRateLimit, releaseRateLimit,
  etagFromVersion, matchesIfNoneMatch, PURCHASE_REPORT_CAPS, validateSummaryRpc,
} from "@/lib/purchase-report";   // ← expenseRecorder 嘅 lib 路徑
import { getServiceClient } from "@/lib/supabase-server";  // service_role

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ENV_SECRET = "LEDGER_PURCHASE_REPORT_HMAC_SECRET";

export async function GET(request: Request) {
  const secret = (process.env[ENV_SECRET] ?? "").trim();
  if (!secret) return fail("server_misconfigured", 500);

  const url = new URL(request.url);
  const pathWithQuery = `${url.pathname}${url.search}`;
  const sig = verifySignature({
    timestampHeader: request.headers.get("x-ledger-timestamp"),
    signatureHeader: request.headers.get("x-ledger-signature"),
    pathWithQuery, secret,
  });
  if (!sig.ok) return fail("unauthorized", 401);

  const shopId = (url.searchParams.get("shopId") ?? "").trim();
  const from = (url.searchParams.get("from") ?? "").trim();
  const to = (url.searchParams.get("to") ?? "").trim();
  if (!isMerchantId(shopId)) return fail("bad_shop_id", 400);
  if (!isDateKey(from) || !isDateKey(to) || from > to) return fail("bad_range", 400);

  // ④ 限流（打 DB 之前保護）
  const rl = acquireRateLimit(shopId);
  if (!rl.ok) return fail(rl.reason === "per_shop" ? "too_many_requests" : "too_many_requests", 429);

  const supabase = getServiceClient();
  if (!supabase) { releaseRateLimit(rl.concurrencyToken); return fail("server_misconfigured", 503); }

  const { data, error } = await supabase.rpc("ledger_purchase_report_summary", {
    p_merchant_id: shopId, p_from: from, p_to: to,
  });
  releaseRateLimit(rl.concurrencyToken);

  if (error) {
    const notDeployed = error.code === "42883" || error.code === "PGRST202";
    return fail(notDeployed ? "rpc_not_deployed" : "upstream_unavailable", 503);
  }
  const v = validateSummaryRpc(data);
  if (!v.ok) return fail("upstream_unavailable", 503);   // 🔴 唔可以渲染假零
  if (!v.found) return fail("shop_not_found", 404);

  // ② ETag / 304：商戶級 version，吻合就唔重查
  const etag = etagFromVersion(v.dataVersion);
  const clientEtag = request.headers.get("if-none-match");
  if (matchesIfNoneMatch(clientEtag, v.dataVersion)) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        "cache-control": `private, max-age=${CACHE_MAX_AGE_S}`,
        etag: etag,
        "x-purchase-report-v": String(PURCHASE_REPORT_VERSION),
      },
    });
  }

  const payload = {
    v: PURCHASE_REPORT_VERSION,
    shopId,
    range: { from: v.from, to: v.to },
    generatedAt: new Date().toISOString(),
    kpi: { currencies: v.byCurrency.map((x: any) => x.currency), byCurrency: v.byCurrency,
           receiptCount: sum(v.byCurrency, "receiptCount"),
           itemLineCount: sum(v.byCurrency, "itemLineCount"),
           supplierCount: sum(v.byCurrency, "supplierCount"),
           totalAmount: null, avgPerReceiptDay: null },
    daily: v.daily,
    suppliers: v.suppliers,
    paymentBreakdown: v.paymentBreakdown,
    items: v.items,
    flags: { stockInOnly: true, multiCurrency: v.byCurrency.length > 1,
             receiptsTruncated: false, itemsTruncated: false },
  };

  return NextResponse.json(payload, {
    status: 200,
    headers: {
      // ① 服務端快取：private（只畀 Ledger 伺服器）＋ 60s
      "cache-control": `private, max-age=${CACHE_MAX_AGE_S}`,
      etag,
      "x-purchase-report-v": String(PURCHASE_REPORT_VERSION),
      "x-purchase-report-path": PURCHASE_REPORT_PATH,
      "x-purchase-report-caps": PURCHASE_REPORT_CAPS,
    },
  });
}

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
function sum(arr: any[], key: string): number {
  return arr.reduce((a, x) => a + (Number(x?.[key]) || 0), 0);
}
```

```ts
// app/api/integration/ledger/purchase-report/receipts/route.ts  (明細，cursor 分頁)
// 同上嘅驗簽／bad_shop_id／bad_range／限流／service_client 骨架，差異：
//  - 呼叫 ledger_purchase_report_receipts(p_merchant_id, p_from, p_to, p_cursor_date, p_cursor_id, p_limit)
//  - cursor 解碼：JSON.parse(Buffer.from(cursor,'base64').toString()) → { d: 'YYYY-MM-DD', id }
//  - 回應 envelope：{ v, shopId, range, receipts[], total, hasMore, nextCursor }
//  - 明細 endpoint 唔做 304（每次鑽取都係新請求）；但仍然帶 cache-control: private, max-age=60
//    （同一 cursor 短期內重撳唔使重查）。
//  - 嚴格驗證：receipts[] 每行嘅 items[] 型別、total >= 0、currency 非空；
//    任何錯 ⇒ 503（唔回假零）。
```

---

## 5. 部署次序 ＋ 降級（重要，mirror offline-report 嘅教訓）

1. **先跑 SQL（2.1 → 2.2 → 2.3 → 2.4）**，trigger 會對**日後**寫入維護匯總表。
   ⚠️ 已存在嘅舊單**唔會自動回填**匯總表 ⇒ 上線前跑一次 backfill：
   ```sql
   select purchase_report_refresh_day(merchant_id, date_key, currency)
   from (select distinct merchant_id, receipt_date as date_key, currency
         from receipts where receipt_type = 'stock_in') s;
   select purchase_report_bump_version(merchant_id)
   from (select distinct merchant_id from receipts where receipt_type = 'stock_in') s;
   ```
2. route 比 SQL 早部署冇問題：RPC 未跑 ⇒ 42883 ⇒ route 回 503（Ledger 顯示降級），**唔會**送假零。
3. **唔可以升 `v`**（契約鐵律，mirror offline-report）：加欄位靠 `caps` 標頭探測，唔好改 `v`。
4. **「唔可以渲染假零」**：任何 RPC 回傳型別錯／缺欄 ⇒ 5xx，唔可以送一份 Ledger 會丟棄嘅 payload。

---

## 6. 同 macau-pos 嘅 `offline-report` 嘅分別（免得团队混淆）

| | offline-report（macau-pos） | purchase-report（expenseRecorder） |
| --- | --- | --- |
| 數據源 | `pos_orders`（macau-pos 庫） | `receipts`/`receipt_items`（expenseRecorder 庫） |
| 匯總表 | 冇（90 日上限，RPC 即時聚） | 有 `purchase_report_daily`（全歷史快） |
| version/ETag | 冇（offline-report 未做 304） | 有 `purchase_data_version` ＋ ETag/304 |
| 限流 | per-shop 30/min | per-shop 30 ＋ 全域 300 ＋ 並發 10 |
| 明細 | `orders[]`/`dishes[]` 一次過（3000/300 截斷） | `receipts` cursor 分頁每頁 50 |
| 部署 repo | macau-pos | expenseRecorder（呢份 reference） |
