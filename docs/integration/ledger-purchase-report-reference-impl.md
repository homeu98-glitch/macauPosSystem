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
| ① 服務端快取 | route 回 `Cache-Control: private, max-age=60`（提示 Ledger）＋ **Redis 真．服務端快取** 60s，key=(shopId,from,to,dataVersion)；見 §3.1 |
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

-- 🟡 索引（修 point 8 建議）：suppliers/payment/items 仍要掃全區間原始單據，
--    呢兩條索引令「按店＋類型＋日期」同「按單頭撈品項」走索引而唔係 seq scan。
create index if not exists receipts_merchant_type_date_idx
  on receipts (merchant_id, receipt_type, receipt_date);
create index if not exists receipt_items_receipt_id_idx
  on receipt_items (receipt_id);
```

### 2.2 維護 trigger（每日匯總 ＋ version bump）

```sql
-- 00XX_b_purchase_report_triggers.sql
-- 重算某 (merchant, date, currency) 嘅每日匯總行。
-- ⚠️ 修 point 8：原版 insert...on conflict 之後 `if not found then delete` 永遠唔會執行
--    （upsert 一定 found 一行）。改為：先數該 (merchant,date,currency) 仲有冇單，
--    0 張就 delete 殘留行，>0 就 upsert。
create or replace function purchase_report_refresh_day(
  p_merchant_id text, p_date date, p_currency text
) returns void language plpgsql as $$
declare
  v_rows bigint;
begin
  select count(*) into v_rows
  from receipts r
  where r.merchant_id = p_merchant_id
    and r.receipt_type = 'stock_in'
    and r.receipt_date = p_date
    and r.currency = p_currency;

  if v_rows = 0 then
    -- 該日無單 ⇒ 清走該行（避免殘留 0 行，ETag 唔會因此 stale）
    delete from purchase_report_daily
    where merchant_id = p_merchant_id and date_key = p_date and currency = p_currency;
    return;
  end if;

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
      -- 🟡 改單改咗 merchant_id ⇒ 舊店 version 都要 bump（否則舊店 ETag 唔會失效）
      if OLD.merchant_id is distinct from NEW.merchant_id then
        perform purchase_report_bump_version(OLD.merchant_id);
      end if;
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

-- 🔴 修 point 5：receipt_items 變動（加／改／刪品項）都要 refresh 所屬單嘅 (day,currency)
--    匯總 ＋ bump 該店 dataVersion。否則 item_line_count 會停在 0、ETag 唔會變
--    （一般流程先寫單頭再寫品項，冇呢個 trigger 就永遠 bump 唔到品項相關變動）。
create or replace function purchase_report_maintain_items() returns trigger language plpgsql as $$
declare
  v_merchant text; v_date date; v_currency text;
begin
  if TG_OP = 'DELETE' then
    select merchant_id, receipt_date, currency into v_merchant, v_date, v_currency
    from receipts where id = OLD.receipt_id;
  else
    select merchant_id, receipt_date, currency into v_merchant, v_date, v_currency
    from receipts where id = NEW.receipt_id;
  end if;
  if v_merchant is null then return coalesce(NEW, OLD); end if;  -- 孤兒 item，skip
  perform purchase_report_refresh_day(v_merchant, v_date, v_currency);
  perform purchase_report_bump_version(v_merchant);
  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists purchase_report_maintain_items on receipt_items;
create trigger purchase_report_maintain_items
  after insert or update or delete on receipt_items
  for each row execute function purchase_report_maintain_items();
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
  v_supplier_count bigint;
  v_item_line_count bigint;
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

  -- 修 point 6：found = 店舖有冇綁定（merchants 表），唔係「有冇 stock_in 單」。
  --   綁定咗但區間內無單 ⇒ 回 200 空結果（對齊契約 §8）；完全未綁定 ⇒ 404 shop_not_found。
  --   ⚠️ 若 expenseRecorder 嘅綁定表唔叫 merchants，改下面張表名就得（route 層唔使郁）。
  select exists (
    select 1 from merchants m where m.id = p_merchant_id
  ) into v_found;

  select coalesce(version, 0) from purchase_data_version where merchant_id = p_merchant_id
    into v_version;

  -- 修 point 4：supplierCount / itemLineCount 係 range-level，絕對唔可以由 byCurrency 加總
  --   （同一供應商跨日會被重複計）。直接對整個區間 count。
  select count(distinct r.supplier_id) into v_supplier_count
  from receipts r
  where r.merchant_id = p_merchant_id and r.receipt_type = 'stock_in'
    and r.receipt_date between v_from and v_to;

  select count(*) into v_item_line_count
  from receipt_items it
  join receipts r on r.id = it.receipt_id
  where r.merchant_id = p_merchant_id and r.receipt_type = 'stock_in'
    and r.receipt_date between v_from and v_to;

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

  -- items[]：品項聚合（name+unit+currency 合併）＋ 升跌（今次區間加權均價 vs 上次買入均價）
  --   修 point 8：移除原本嘅 `...` 佔位符，改用正確嘅 range-level 聚合 ＋ 子查詢攞「上次」
  --   口徑（契約 §5.2）：key = lower(btrim(name))（同名跨單據合併）；
  --   今次加權均價 = Σtotal_price / Σquantity（區間內）；上次 = 區間之前（receipt_date < v_from）
  --   所有同款嘅加權均價。方向 up/down/same/new。
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
    select
      name, unit, currency, total_quantity, total_amount, line_count, last_purchase_date,
      case
        when prev_avg is null or prev_avg = 0 then 'new'
        when cur_avg > prev_avg then 'up'
        when cur_avg < prev_avg then 'down'
        else 'same'
      end as direction,
      case
        when prev_avg is null or prev_avg = 0 then null
        else round((cur_avg - prev_avg) / prev_avg * 100, 2)
      end as change_percent
    from (
      select
        it.name, it.unit, r.currency,
        sum(it.quantity) total_quantity,
        sum(it.total_price) total_amount,
        count(*) line_count,
        max(r.receipt_date)::text last_purchase_date,
        case when sum(it.quantity) > 0 then sum(it.total_price) / sum(it.quantity) else null end as cur_avg,
        -- 上次買入均價：區間之前同款嘅加權均價（冇就 null → new）
        (
          select case when sum(it2.quantity) > 0
                      then sum(it2.total_price) / sum(it2.quantity) else null end
          from receipt_items it2
          join receipts r2 on r2.id = it2.receipt_id
          where r2.merchant_id = p_merchant_id and r2.receipt_type = 'stock_in'
            and r2.receipt_date < v_from
            and lower(btrim(it2.name)) = lower(btrim(it.name))
            and coalesce(it2.unit, '') = coalesce(it.unit, '')
            and r2.currency = r.currency
        ) as prev_avg
      from receipt_items it
      join receipts r on r.id = it.receipt_id
      where r.merchant_id = p_merchant_id and r.receipt_type = 'stock_in'
        and r.receipt_date between v_from and v_to
      group by it.name, it.unit, r.currency
    ) g
  ) agg;

  return jsonb_build_object(
    'found', v_found,
    'from', to_char(v_from, 'YYYY-MM-DD'),
    'to',   to_char(v_to, 'YYYY-MM-DD'),
    'dataVersion', v_version,
    'supplierCount', coalesce(v_supplier_count, 0),
    'itemLineCount', coalesce(v_item_line_count, 0),
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

> ✅ **items[].changePercent / direction 口徑**：上面 RPC 已經落實（修 point 8 移除咗原本嘅 `...` 佔位符）。
> 口徑 = 契約 §5.2：key = `lower(btrim(name))`（同名跨單據合併）；今次加權均價 = Σtotal_price / Σquantity（區間內）；
> 上次買入均價 = 區間之前（`receipt_date < v_from`）所有同款嘅加權均價。`direction` ∈ {up,down,same,new}、
> `changePercent` 計法請用 §7 嘅 pgTAP／單元測試鎖死（參考 macau-pos `src/lib/purchase-items.ts` 嘅 `buildItemStats`：
> key = name 去空白轉小寫、金額 = Σ 單價×數量）。

### 2.4 RPC：`receipts`（cursor 分頁，每頁 50）

```sql
-- base64url 編碼（修 point 8）：標準 base64 會每 76 字元插入換行、用 +/，
--   唔合 cursor 嘅「opaque base64url」要求。呢度去換行、+/ → -_、去 padding。
--   解碼見 lib 側 decodeCursor()（Buffer.from(c,'base64url')）。
create or replace function b64url_encode(p_text text) returns text
language sql immutable as $$
  select replace(
           replace(
             replace(
               replace(encode(convert_to(p_text, 'utf8'), 'base64'), E'\n', ''),
             '+', '-'),
           '/', '_'),
         '=', '');
$$;

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
  v_has_more boolean;
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
  --   limit v_limit + 1：多攞 1 行用嚟判斷 hasMore；之後用 row_number 永遠切到 v_limit。
  --   修 point 8：唔用 ` #- `（要 text[] 路徑、易錯），改用 row_number() <= v_limit 切片。
  with base as (
    select r.*, row_number() over (order by r.receipt_date desc, r.id desc) as rn
    from receipts r
    where r.merchant_id = p_merchant_id and r.receipt_type = 'stock_in'
      and r.receipt_date between v_from and v_to
      and (p_cursor_date is null or
           (r.receipt_date, r.id) < (p_cursor_date, p_cursor_id))
    order by r.receipt_date desc, r.id desc
    limit v_limit + 1
  )
  select (select count(*) from base) > v_limit into v_has_more;

  select coalesce(jsonb_agg(jsonb_build_object(
            'receiptId', id,
            'receiptNumber', receipt_number,
            'receiptDate', to_char(receipt_date, 'YYYY-MM-DD'),
            'recordedAt', recorded_at,   -- 修 point 8：null 就返 null，唔好用 now() 捏造
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
  from base r
  where rn <= v_limit;   -- 永遠切到 limit；hasMore 由 count 決定，唔會多一頁空頁

  if jsonb_array_length(v_rows) > 0 then
    v_last_date := (v_rows -> (jsonb_array_length(v_rows) - 1) ->> 'receiptDate')::date;
    v_last_id   := (v_rows -> (jsonb_array_length(v_rows) - 1) ->> 'receiptId')::uuid;
  end if;

  -- 修 point 8：nextCursor 只喺 hasMore 先有值。滿 50 嘅最尾頁 hasMore=false ⇒ null，
  --   唔會令 Ledger 多拉一頁空頁。cursor 用 b64url_encode（唔係標準 base64）。
  return jsonb_build_object(
    'receipts', v_rows,
    'total', v_total,
    'hasMore', v_has_more,
    'nextCursor', case when v_has_more and v_last_id is not null
                   then b64url_encode(json_build_object('d', v_last_date, 'id', v_last_id)::text)
                   else null end
  );
end;
$$;
```

> ✅ 上面 `hasMore` 已修正（修 point 8）：`v_has_more := (select count(*) from base) > v_limit`，
> 再 `row_number() <= v_limit` 切片，唔會多一頁空頁。`nextCursor` 綁 `v_has_more`，滿 50 最尾頁唔會出 cursor。
> cursor 編碼用 `b64url_encode`（base64url，去換行／+/→-_／去 padding）；
> 解碼（route 側）：`Buffer.from(cursor,'base64url').toString()` → `JSON.parse` → `{d, id}`（見 lib `decodeCursor()`）。

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
// ⚠️ 修 point 7（待雙方確認）：契約 §2 sample 用 SHOP_000123，但原本 validation 只收 UUID，
//   兩邊矛盾。真實格式（UUID 定 SHOP_ 前綴）雙方尚未夾。上線前由雙方確認後，**只改呢個常數**：
//   確定 UUID → 用下面 UUID 分支；確定 SHOP_ → 用 SHOP_ 分支。現階段暫時兩者都收，唔會 400 錯殺。
export const MERCHANT_ID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|SHOP_[0-9A-Za-z_-]+)$/i;
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isMerchantId(v: unknown): v is string {
  return typeof v === "string" && MERCHANT_ID_RE.test(v.trim());
}
export function isDateKey(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = DATE_KEY_RE.exec(v.trim());
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// ── cursor 編解碼（修 point 8：base64url，唔係標準 base64）──────────────
//   SQL 側用 b64url_encode() 編；呢度用 Node Buffer 'base64url' 解（自動忽略 padding、URL-safe）。
export function encodeCursor(d: string, id: string): string {
  return Buffer.from(JSON.stringify({ d, id }), "utf8").toString("base64url");
}
export function decodeCursor(c: string): { d: string; id: string } | null {
  try {
    const o = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (o && typeof o.d === "string" && typeof o.id === "string") return { d: o.d, id: o.id };
    return null;
  } catch {
    return null;
  }
}

// ── ④ 限流（三維：per-shop + 全域 + 並發）─────────────────────────────
// 🔴 修 point 3：下面呢個 in-memory 版本 **只可以用喺本地開發／單測**。
//    Vercel 多實例下每個實例各算各，收唔住「全域 300／並發 10」，而且被擋嗰刻 per-shop 計數
//    已經先 +1 冇退（bug）。生產必須用 §3.1 嘅 Redis 版本（Lua 原子判定 ＋ 原子加數，
//    被擋唔會加數；429 帶 Retry-After）。
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
  supplierCount: number; itemLineCount: number;
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
  // 修 point 4：supplierCount / itemLineCount 係 RPC 直接回嘅 range-level 真值，
  //   唔係由 route 由 byCurrency 加總（嗰度根本冇呢兩欄）。缺／錯類型 ⇒ 5xx，唔回假零。
  if (typeof r.supplierCount !== "number" || !Number.isFinite(r.supplierCount)) {
    return { ok: false, reason: "rpc-bad-supplierCount" };
  }
  if (typeof r.itemLineCount !== "number" || !Number.isFinite(r.itemLineCount)) {
    return { ok: false, reason: "rpc-bad-itemLineCount" };
  }
  for (const k of ["byCurrency", "daily", "suppliers", "paymentBreakdown", "items"] as const) {
    if (!Array.isArray(r[k])) return { ok: false, reason: `rpc-bad-${k}` };
  }
  return {
    ok: true, found: r.found, from: r.from, to: r.to, dataVersion: r.dataVersion,
    supplierCount: r.supplierCount, itemLineCount: r.itemLineCount,
    byCurrency: r.byCurrency, daily: r.daily, suppliers: r.suppliers,
    paymentBreakdown: r.paymentBreakdown, items: r.items,
  };
}

export type ReceiptsRpc = {
  ok: true; receipts: unknown[]; total: number; hasMore: boolean; nextCursor: string | null;
} | { ok: false; reason: string };

// 明細 endpoint 回傳驗證：修 point 8（nextCursor 一定係 b64url string 或 null）、
// 每行 receipt 嘅 items[] 都要係 array。任何型別錯 ⇒ 5xx，唔回假零。
export function validateReceiptsRpc(raw: unknown): ReceiptsRpc {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "rpc-not-object" };
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.receipts)) return { ok: false, reason: "rpc-bad-receipts" };
  if (typeof r.total !== "number" || !Number.isFinite(r.total) || r.total < 0) return { ok: false, reason: "rpc-bad-total" };
  if (typeof r.hasMore !== "boolean") return { ok: false, reason: "rpc-bad-hasMore" };
  if (!(r.nextCursor === null || typeof r.nextCursor === "string")) return { ok: false, reason: "rpc-bad-nextCursor" };
  for (const rc of r.receipts as unknown[]) {
    const o = rc as Record<string, unknown>;
    if (typeof o.receiptId !== "string") return { ok: false, reason: "rpc-bad-receipt-row" };
    if (!Array.isArray(o.items)) return { ok: false, reason: "rpc-bad-receipt-items" };
  }
  return { ok: true, receipts: r.receipts, total: r.total, hasMore: r.hasMore, nextCursor: r.nextCursor as string | null };
}
```

---

### 3.1 Redis 快取 ＋ 限流（生產用；接 Upstash Redis）

🔴 修 point 2（服務端快取）＋ point 3（限流）：下面呢層先係**真正**嘅服務端保護。
`Cache-Control: private, max-age=60` 只係畀 Ledger 嘅提示，**服務端自己要存結果**先慳到 DB。
Vercel 多實例下 in-memory 收唔住，所以全部放 Redis（Upstash，REST，唔使開連線池）。

```ts
// purchase-report-redis.ts  (expenseRecorder 嘅 lib；接 Upstash Redis)
import { Redis } from "@upstash/redis";

export function makeRedis(): Redis {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

// ── ① 服務端快取：key 含 dataVersion ⇒ 版本一 bump 即刻 miss，唔會 stale ──
export const CACHE_TTL_S = 60;
export function summaryCacheKey(shopId: string, from: string, to: string, dataVersion: number | bigint) {
  return `pr:summary:${shopId}:${from}:${to}:v${dataVersion}`;
}
export function receiptsCacheKey(shopId: string, from: string, to: string, cursor: string | null, dataVersion: number | bigint) {
  return `pr:rcpt:${shopId}:${from}:${to}:${cursor ?? "first"}:v${dataVersion}`;
}
// Upstash 自動 JSON 序列化／還原；payload 直接過 set/get。
export async function getCached<T = unknown>(redis: Redis, key: string): Promise<T | null> {
  const v = await redis.get<T>(key);
  return v === null || v === undefined ? null : v;
}
export async function setCached(redis: Redis, key: string, payload: unknown): Promise<void> {
  await redis.set(key, payload, { ex: CACHE_TTL_S });
}

// ── ④ 限流：一段 Lua 原子判定三維，只在 allow 嗰刻先加數 ──
//    ⇒ 修 point 3 嘅「被擋先加 1 冇退」bug；並發用第 3 個 key 做信號量（SET NX 語意由 INCR 擔當）。
// KEYS = [shopKey, globalKey, activeKey]
// ARGV = [windowSec, perShopMax, globalMax, concurrencyMax]
const RATE_LIMIT_LUA = `
local window = tonumber(ARGV[1])
local perShopMax = tonumber(ARGV[2])
local globalMax = tonumber(ARGV[3])
local concurrencyMax = tonumber(ARGV[4])
if redis.call('EXISTS', KEYS[1]) == 0 then redis.call('SET', KEYS[1], 0, 'EX', window) end
if redis.call('EXISTS', KEYS[2]) == 0 then redis.call('SET', KEYS[2], 0, 'EX', window) end
if redis.call('EXISTS', KEYS[3]) == 0 then redis.call('SET', KEYS[3], 0, 'EX', window) end
local shop = tonumber(redis.call('GET', KEYS[1]))
local glob = tonumber(redis.call('GET', KEYS[2]))
local active = tonumber(redis.call('GET', KEYS[3]))
if shop >= perShopMax then return cjson.encode({ok=0, reason='per_shop', retryAfter=window}) end
if glob >= globalMax then return cjson.encode({ok=0, reason='global', retryAfter=window}) end
if active >= concurrencyMax then return cjson.encode({ok=0, reason='concurrency', retryAfter=1}) end
redis.call('INCR', KEYS[1]); redis.call('INCR', KEYS[2]); redis.call('INCR', KEYS[3])
return cjson.encode({ok=1})
`;
// 釋放並發信號量（release）：只有 >0 先 DECR，避免 EXPIRE 重置後變負。
const RELEASE_LUA = `
if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then redis.call('DECR', KEYS[1]) end
return 1
`;

export type RateLimitResult =
  | { ok: true }
  | { ok: false; reason: "per_shop" | "global" | "concurrency"; retryAfter: number };

export async function acquireRateLimit(
  redis: Redis, shopId: string,
  cfg: { windowSec: number; perShopMax: number; globalMax: number; concurrencyMax: number },
): Promise<RateLimitResult> {
  const res = await redis.eval(RATE_LIMIT_LUA, {
    keys: [`rl:shop:${shopId}`, "rl:global", "rl:active"],
    args: [cfg.windowSec, cfg.perShopMax, cfg.globalMax, cfg.concurrencyMax],
  }) as string;
  const p = JSON.parse(res) as { ok: number; reason?: string; retryAfter?: number };
  return p.ok === 1
    ? { ok: true }
    : { ok: false, reason: (p.reason as any) ?? "global", retryAfter: p.retryAfter ?? cfg.windowSec };
}
export async function releaseRateLimit(redis: Redis): Promise<void> {
  await redis.eval(RELEASE_LUA, { keys: ["rl:active"], args: [] });
}
```

> ⚠️ `redis.eval` 嘅確實簽名視 client 而定；上面用 Upstash `@upstash/redis` 嘅
> `redis.eval(script, { keys, args })`。若改用 `ioredis`，寫法係 `redis.eval(script, keys.length, ...keys, ...args)`。
>
> 🟡 **吵鬧鄰居**：全域 300/min 會令單一高用量店擠到其他店。建議：(a) 全域上限調高
> （例如 1000~2000），主要靠 **per-shop 30 ＋ 並發 10** 做保護；或 (b) 按店公平分配全域額度。
> 兩者都係 tuning，唔影響呢段 Lua 嘅正確性 —— `globalMax` 設成可配置就得。

---

## 4. route（Next.js）：`purchase-report/route.ts` ＋ `purchase-report/receipts/route.ts`

兩條都係**公開網段可達**（Ledger 伺服器打過嚟），冇店員 session ⇒ 用 HMAC 代替 `posRouteAuthGuard()`。
**唔可以**加 `posRouteAuthGuard()`（會即刻 401，Ledger 張卡變「暫時無法取得」）。

```ts
// app/api/integration/ledger/purchase-report/route.ts  (summary)
import { NextResponse } from "next/server";
import {
  PURCHASE_REPORT_PATH, PURCHASE_REPORT_VERSION, CACHE_MAX_AGE_S,
  verifySignature, isMerchantId, isDateKey,
  etagFromVersion, matchesIfNoneMatch, PURCHASE_REPORT_CAPS, validateSummaryRpc,
} from "@/lib/purchase-report";   // ← expenseRecorder 嘅 lib 路徑
import {
  makeRedis, acquireRateLimit, releaseRateLimit,
  getCached, setCached, summaryCacheKey,
} from "@/lib/purchase-report-redis";  // ← ① 服務端快取 ＋ ④ 限流（Redis）
import { getServiceClient } from "@/lib/supabase-server";  // service_role

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ENV_SECRET = "LEDGER_PURCHASE_REPORT_HMAC_SECRET";
const RATE_CFG = { windowSec: 60, perShopMax: 30, globalMax: 300, concurrencyMax: 10 };

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

  // ④ 限流（Redis；打 DB 之前保護；被擋帶 Retry-After）
  const redis = makeRedis();
  const rl = await acquireRateLimit(redis, shopId, RATE_CFG);
  if (!rl.ok) return fail429(rl.reason, rl.retryAfter);

  const supabase = getServiceClient();
  if (!supabase) { await releaseRateLimit(redis); return fail("server_misconfigured", 503); }

  try {
    // ② 修 point 1：先輕量查 dataVersion（PK lookup，唔掃單據），吻合 If-None-Match 就 304，
    //    唔使跑成個 summary RPC。版本號亦用嚟做 cache key。
    const { data: verRow, error: verErr } = await supabase
      .from("purchase_data_version").select("version").eq("merchant_id", shopId).maybeSingle();
    if (verErr) { await releaseRateLimit(redis); return fail("upstream_unavailable", 503); }
    const dataVersion = Number(verRow?.version ?? 0);

    const etag = etagFromVersion(dataVersion);
    const clientEtag = request.headers.get("if-none-match");
    if (matchesIfNoneMatch(clientEtag, dataVersion)) {
      await releaseRateLimit(redis);
      return new NextResponse(null, {
        status: 304,
        headers: {
          "cache-control": `private, max-age=${CACHE_MAX_AGE_S}`,
          etag, "x-purchase-report-v": String(PURCHASE_REPORT_VERSION),
        },
      });
    }

    // ① 修 point 2：服務端快取（Redis 60s，key 含 dataVersion ⇒ 版本一變即刻 miss，唔會 stale）
    const cacheKey = summaryCacheKey(shopId, from, to, dataVersion);
    const cached = await getCached<Record<string, unknown>>(redis, cacheKey);
    if (cached) {
      await releaseRateLimit(redis);
      return NextResponse.json(cached, { status: 200, headers: cacheHeaders(etag) });
    }

    const { data, error } = await supabase.rpc("ledger_purchase_report_summary", {
      p_merchant_id: shopId, p_from: from, p_to: to,
    });
    if (error) {
      const notDeployed = error.code === "42883" || error.code === "PGRST202";
      await releaseRateLimit(redis);
      return fail(notDeployed ? "rpc_not_deployed" : "upstream_unavailable", 503);
    }
    const v = validateSummaryRpc(data);
    if (!v.ok) { await releaseRateLimit(redis); return fail("upstream_unavailable", 503); }  // 🔴 唔可以渲染假零
    if (!v.found) { await releaseRateLimit(redis); return fail("shop_not_found", 404); }     // 修 point 6：未綁定先 404

    const payload = {
      v: PURCHASE_REPORT_VERSION,
      shopId,
      range: { from: v.from, to: v.to },
      generatedAt: new Date().toISOString(),
      kpi: {
        currencies: v.byCurrency.map((x: any) => x.currency),
        byCurrency: v.byCurrency,
        receiptCount: sum(v.byCurrency, "receiptCount"),
        // 修 point 4：直接拎 RPC 返嘅 range-level 真值，唔再由 byCurrency 加總（避免假零／跨日重複計供應商）
        itemLineCount: v.itemLineCount,
        supplierCount: v.supplierCount,
        totalAmount: null, avgPerReceiptDay: null,
      },
      daily: v.daily,
      suppliers: v.suppliers,
      paymentBreakdown: v.paymentBreakdown,
      items: v.items,
      flags: { stockInOnly: true, multiCurrency: v.byCurrency.length > 1,
               receiptsTruncated: false, itemsTruncated: false },
    };

    await setCached(redis, cacheKey, payload);
    await releaseRateLimit(redis);
    return NextResponse.json(payload, { status: 200, headers: cacheHeaders(etag) });
  } catch {
    await releaseRateLimit(redis);
    return fail("upstream_unavailable", 503);
  }
}

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
function fail429(reason: string, retryAfter: number) {
  return NextResponse.json({ error: "too_many_requests", detail: reason }, {
    status: 429,
    headers: {
      "cache-control": "no-store",
      "retry-after": String(Math.max(1, Math.ceil(retryAfter))),
    },
  });
}
function cacheHeaders(etag: string): Record<string, string> {
  return {
    "cache-control": `private, max-age=${CACHE_MAX_AGE_S}`,
    etag,
    "x-purchase-report-v": String(PURCHASE_REPORT_VERSION),
    "x-purchase-report-path": PURCHASE_REPORT_PATH,
    "x-purchase-report-caps": PURCHASE_REPORT_CAPS,
  };
}
function sum(arr: any[], key: string): number {
  return arr.reduce((a, x) => a + (Number(x?.[key]) || 0), 0);
}
```

```ts
// app/api/integration/ledger/purchase-report/receipts/route.ts  (明細，cursor 分頁)
// 同 summary 嘅驗簽／bad_shop_id／bad_range／Redis 限流／service_client 骨架，差異：
//  - 呼叫 ledger_purchase_report_receipts(p_merchant_id, p_from, p_to, p_cursor_date, p_cursor_id, p_limit)
//  - cursor 解碼（修 point 8：base64url）：decodeCursor(cursor) → { d: 'YYYY-MM-DD', id }
//  - 回應 envelope：{ v, shopId, range, receipts[], total, hasMore, nextCursor }
//  - 明細 endpoint 唔做 304（每次鑽取都係新請求）；但仍然帶 cache-control: private, max-age=60
//    （同一 cursor 短期內重撳唔使重查，呢度用 Redis 快取落實）。
//  - 嚴格驗證：receipts[] 每行嘅 items[] 型別、total >= 0、nextCursor string|null；
//    任何錯 ⇒ 503（唔回假零）。
import { NextResponse } from "next/server";
import {
  PURCHASE_REPORT_RECEIPTS_PATH, PURCHASE_REPORT_VERSION, CACHE_MAX_AGE_S,
  verifySignature, isMerchantId, isDateKey, decodeCursor, validateReceiptsRpc,
} from "@/lib/purchase-report";
import {
  makeRedis, acquireRateLimit, releaseRateLimit, getCached, setCached, receiptsCacheKey,
} from "@/lib/purchase-report-redis";
import { getServiceClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const ENV_SECRET = "LEDGER_PURCHASE_REPORT_HMAC_SECRET";
const RATE_CFG = { windowSec: 60, perShopMax: 30, globalMax: 300, concurrencyMax: 10 };

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
  const cursor = (url.searchParams.get("cursor") ?? "").trim();
  if (!isMerchantId(shopId)) return fail("bad_shop_id", 400);
  if (!isDateKey(from) || !isDateKey(to) || from > to) return fail("bad_range", 400);
  const decoded = cursor ? decodeCursor(cursor) : null;       // 修 point 8：base64url 解碼
  if (cursor && !decoded) return fail("bad_cursor", 400);      // 壞 cursor 直接 400，唔糊弄

  const redis = makeRedis();
  const rl = await acquireRateLimit(redis, shopId, RATE_CFG);
  if (!rl.ok) return fail429(rl.reason, rl.retryAfter);

  const supabase = getServiceClient();
  if (!supabase) { await releaseRateLimit(redis); return fail("server_misconfigured", 503); }

  try {
    // 輕量 version（做 cache key；明細唔做 304，但版本一變 cache 即 miss）
    const { data: verRow, error: verErr } = await supabase
      .from("purchase_data_version").select("version").eq("merchant_id", shopId).maybeSingle();
    if (verErr) { await releaseRateLimit(redis); return fail("upstream_unavailable", 503); }
    const dataVersion = Number(verRow?.version ?? 0);

    // ① 服務端快取（Redis 60s，key 含 cursor + dataVersion）
    const cacheKey = receiptsCacheKey(shopId, from, to, cursor || null, dataVersion);
    const cached = await getCached<Record<string, unknown>>(redis, cacheKey);
    if (cached) { await releaseRateLimit(redis); return NextResponse.json(cached, { status: 200, headers: cacheHeaders() }); }

    const { data, error } = await supabase.rpc("ledger_purchase_report_receipts", {
      p_merchant_id: shopId, p_from: from, p_to: to,
      p_cursor_date: decoded?.d ?? null, p_cursor_id: decoded?.id ?? null, p_limit: 50,
    });
    if (error) {
      const notDeployed = error.code === "42883" || error.code === "PGRST202";
      await releaseRateLimit(redis);
      return fail(notDeployed ? "rpc_not_deployed" : "upstream_unavailable", 503);
    }
    const v = validateReceiptsRpc(data);
    if (!v.ok) { await releaseRateLimit(redis); return fail("upstream_unavailable", 503); }  // 🔴 唔可以渲染假零

    const payload = {
      v: PURCHASE_REPORT_VERSION, shopId, range: { from, to },
      receipts: v.receipts, total: v.total, hasMore: v.hasMore, nextCursor: v.nextCursor,
    };
    await setCached(redis, cacheKey, payload);
    await releaseRateLimit(redis);
    return NextResponse.json(payload, { status: 200, headers: cacheHeaders() });
  } catch {
    await releaseRateLimit(redis);
    return fail("upstream_unavailable", 503);
  }
}

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
function fail429(reason: string, retryAfter: number) {
  return NextResponse.json({ error: "too_many_requests", detail: reason }, {
    status: 429,
    headers: { "cache-control": "no-store", "retry-after": String(Math.max(1, Math.ceil(retryAfter))) },
  });
}
function cacheHeaders(): Record<string, string> {
  return {
    "cache-control": `private, max-age=${CACHE_MAX_AGE_S}`,
    "x-purchase-report-v": String(PURCHASE_REPORT_VERSION),
    "x-purchase-report-path": PURCHASE_REPORT_RECEIPTS_PATH,
    "x-purchase-report-caps": PURCHASE_REPORT_CAPS,
  };
}
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
3. **加欄位唔好再升 `v`**：`v` 已經喺呢版升到 `2`（v1→v2 係唔兼容改動：路徑拆分＋限流收緊＋ETag，契約 §0／§4 已寫明）。
   日後只係加欄位（例如庫存現況）→ 靠 `caps` 標頭探測，唔好再升 `v`，舊 client 見唔到就忽略。
   （原版 §5.3 寫「唔可以升 v」同契約 v=2 矛盾，已修正 —— 升 v 係一次性嘅唔兼容改動，加欄位唔使升。）
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

---

## 7. 測試（鎖死上面嘅不變量，修 v2 審閱嘅錯）

> 上面改動（point 1–8）全部要有測試鎖死，唔可以只靠 code review。分兩層：

### 7.1 純函數（唔使 Redis / DB，已落地可跑）

`tools/purchase-report-reference.test.mjs`（對齊 §3 嘅純函數），`node --test` 跑：

```
# tests 4 / pass 4
- isMerchantId 收 UUID 同 SHOP_ 前綴（point 7）
- cursor base64url round-trip（point 8：URL-safe、無換行）
- hasMore / nextCursor：滿 50 最尾頁唔出 cursor（point 8）
- validateSummaryRpc 要求 supplierCount / itemLineCount（point 4：唔可以假零）
```

### 7.2 SQL 不變量（pgTAP，落 expenseRecorder 嘅 DB 後跑）

```sql
-- 00XX_e_purchase_report_tests.sql  (pgTAP)
begin;
select plan(8);

-- point 8：hasMore 同滿頁 cursor
-- 造 51 張同一日 stock_in 單 ⇒ 第一頁 hasMore=true、nextCursor 非 null
insert into receipts (id, merchant_id, receipt_date, receipt_type, currency, total_amount)
  select gen_random_uuid(), 'M_TEST', '2026-10-11', 'stock_in', 'HKD', 100
  from generate_series(1, 51);
select results_eq(
  $$ select (ledger_purchase_report_receipts('M_TEST','2026-10-11','2026-10-11')::jsonb)->>'hasMore' $$,
  $$ values ('true'::text) $$, '51 張：hasMore=true');
select ok(
  (ledger_purchase_report_receipts('M_TEST','2026-10-11','2026-10-11')::jsonb)->>'nextCursor' is not null,
  '51 張：nextCursor 非 null');

-- 改做 50 張（刪 1 張）⇒ 最尾頁 hasMore=false、nextCursor=null（唔會多一頁空頁）
delete from receipts where merchant_id='M_TEST' and receipt_date='2026-10-11' limit 1;
select results_eq(
  $$ select (ledger_purchase_report_receipts('M_TEST','2026-10-11','2026-10-11')::jsonb)->>'hasMore' $$,
  $$ values ('false'::text) $$, '50 張：hasMore=false');
select ok(
  (ledger_purchase_report_receipts('M_TEST','2026-10-11','2026-10-11')::jsonb)->>'nextCursor' is null,
  '50 張：nextCursor=null（修 point 8 滿頁空頁）');

-- point 4：supplierCount / itemLineCount 係真值，唔係 0（假零）
insert into receipts (id, merchant_id, receipt_date, receipt_type, currency, total_amount, supplier_id)
  values ('11111111-1111-1111-1111-111111111111','M_TEST','2026-10-11','stock_in','HKD',100,'SUP_A');
insert into receipt_items (id, receipt_id, name, quantity, unit_price, total_price)
  values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','米',2,10,20);
select results_eq(
  $$ select (ledger_purchase_report_summary('M_TEST','2026-10-11','2026-10-11')::jsonb)->>'supplierCount',
          (ledger_purchase_report_summary('M_TEST','2026-10-11','2026-10-11')::jsonb)->>'itemLineCount' $$,
  $$ values ('1'::text,'1'::text) $$, 'supplierCount/itemLineCount 唔係 0（修 point 4 假零）');

-- point 6：found = 店舖綁定（merchants），唔係有冇單。M_TEST 冇綁定 merchants ⇒ 404（found=false）
select results_eq(
  $$ select (ledger_purchase_report_summary('M_TEST','2026-10-11','2026-10-11')::jsonb)->>'found' $$,
  $$ values ('false'::text) $$, '未綁定 merchants ⇒ found=false（point 6）');
insert into merchants (id) values ('M_TEST');   -- 綁定後
select results_eq(
  $$ select (ledger_purchase_report_summary('M_TEST','2026-10-11','2026-10-11')::jsonb)->>'found' $$,
  $$ values ('true'::text) $$, '綁定 merchants ⇒ found=true');

-- point 8：receipts 全刪 ⇒ purchase_report_daily 殘留行要清走（if-not-found-delete 修正）
delete from receipts where merchant_id='M_TEST';
select is_empty(
  $$ select 1 from purchase_report_daily where merchant_id='M_TEST' $$,
  '刪晒單 ⇒ 匯總表殘留行清走（修 point 8 if-not-found-delete）');

-- point 8：cursor 係 base64url（無 +/、無換行）
select ok(
  b64url_encode('{"d":"2026-10-11","id":"x"}') not similar to '%[+/]%',
  'b64url_encode 唔含 +/');

select * from finish();
rollback;
```

> ⚠️ 上面 pgTAP 假設 `merchants` 表存在（point 6）。若 expenseRecorder 綁定表唔叫 `merchants`，
> 改 `ledger_purchase_report_summary` 同測試入面嘅表名就得。
> 🟡 另外建議補：point 5（改 receipt_items 後 dataVersion bump）、point 8 `recordedAt` null 不變造（assert 返 null 唔係 now()）。

