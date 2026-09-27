"""用 libpg_query（pglast）驗線下報表 migration（0058 ＋ 0059）嘅語法。

本機／沙箱**冇 Postgres**（migration 一向係商家喺 Supabase SQL Editor 手動貼），
所以呢個 script 用 PostgreSQL 真正嘅 grammar 做語法層驗收：
  ① 外層語句（`create function` / `comment` / `revoke` / `grant`）→ `parse_sql`；
  ② **plpgsql body 逐句入去驗** —— 呢層係 94 號嗰個 checker 冇做嘅（嗰時只抽主查詢），
     做法：把 body 切成 top-level 語句，plpgsql 專屬語法（`if` / `raise`）跳過，
     `v_x := EXPR` → `select EXPR`、`return EXPR` → `select EXPR`、`select … into v_x` → 拔 `into`，
     再代入宣告變數嘅字面值 → `parse_sql`。
     pglast 8.x 已經冇咗 `parse_plpgsql`，所以用呢個拆解法（效果等價：捉括號／CTE／聚合語法錯）。

用法：
  C:/Users/surface/.workbuddy/binaries/python/envs/default/Scripts/python.exe tools/check-pos-offline-report-sql.py

⚠️ 只驗語法，**唔驗執行期**（欄位名／型別／RLS 要喺 Supabase SQL Editor 實跑先驗到）。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    from pglast import parse_sql
except ImportError:  # pragma: no cover
    sys.exit("需要 pglast：pip install pglast")

ROOT = Path(__file__).resolve().parent.parent
SQL_PATHS = [
    ROOT / "supabase" / "migrations" / "0058_pos_offline_report_rpc.sql",
    ROOT / "supabase" / "migrations" / "0059_pos_offline_report_detail.sql",
]

# plpgsql 變數 → 字面值（令語句變成合法 SQL）
VAR_LITERALS = {
    "p_store_id": "'8291f843-9def-4956-9d0b-1cfef2598306'",
    "p_from": "date '2026-09-01'",
    "p_to": "date '2026-09-24'",
    "v_to": "date '2026-09-24'",
    "v_from": "date '2026-09-01'",
    "v_clamped": "false",
    "v_found": "true",
    "v_order_count": "0",
    "v_revenue": "0",
    "v_discount": "0",
    "v_covers": "0",
    "v_refunded": "0",
    "v_by_payment": "'[]'::jsonb",
    "v_orders_total": "0",
    "v_orders": "'[]'::jsonb",
    "v_dishes_total": "0",
    "v_dishes": "'[]'::jsonb",
    "k_tz": "'Asia/Macau'",
    "k_max_days": "90",
    "k_max_method_len": "32",
    "k_max_orders": "3000",
    "k_max_dishes": "300",
    "k_max_name_len": "64",
    "k_max_status_len": "32",
    "k_max_orderno_len": "64",
}


def strip_sql_comments(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def split_statements(body: str) -> list[str]:
    """把 plpgsql body 切成 top-level 語句（追蹤字串狀態同括號深度）。"""
    out: list[str] = []
    buf: list[str] = []
    depth = 0
    in_str = False
    i = 0
    while i < len(body):
        ch = body[i]
        if in_str:
            buf.append(ch)
            if ch == "'":
                if i + 1 < len(body) and body[i + 1] == "'":  # 轉義 ''
                    buf.append(body[i + 1])
                    i += 2
                    continue
                in_str = False
            i += 1
            continue
        if ch == "'":
            in_str = True
            buf.append(ch)
            i += 1
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == ";" and depth == 0:
            out.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    if "".join(buf).strip():
        out.append("".join(buf))
    return out


def sub_vars(sql: str) -> str:
    for name, lit in VAR_LITERALS.items():
        sql = re.sub(rf"(?<![\w.]){name}(?![\w])", lit, sql)
    return sql


def to_sql(stmt: str) -> str | None:
    """plpgsql 語句 → 等價 SQL（唔可以驗嘅回 None）。"""
    s = stmt.strip()
    if not s:
        return None
    low = s.lower()
    if low.startswith(("if ", "else", "elsif", "end if", "raise ", "declare", "begin", "end")):
        return None
    if low.startswith("return "):
        s = "select " + s[len("return ") :]
    else:
        m = re.match(r"^([vk]_\w+)\s*:=\s*([\s\S]+)$", s)
        if m:
            s = "select " + m.group(2)
        s = re.sub(r"\binto\s+v_\w+(\s*,\s*v_\w+)*", "", s)
    s = sub_vars(s)
    return None if not s.strip() else s.strip()


def check_file(sql_path: Path) -> tuple[bool, int]:
    """驗一個 migration 檔；回 (是否全綠, 驗過嘅 body 語句數)。"""
    src = sql_path.read_text(encoding="utf-8")
    ok = True
    print(f"\n=== {sql_path.name} ===")

    try:
        parse_sql(src)
        print("[ OK ] 外層語句（create function + comment + revoke + grant）")
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] 外層語句\n  {type(exc).__name__}: {exc}")
        ok = False

    start = src.find("as $$")
    end = src.rfind("$$;")
    if start < 0 or end <= start:
        print("[FAIL] 搵唔到 plpgsql body（as $$ … $$;）")
        return False, 0

    body = strip_sql_comments(src[start + len("as $$") : end])
    # 由 `begin` 起（`declare` 段係宣告，唔係 SQL 語句，parse 會誤報）
    m = re.search(r"(?m)^\s*begin\s*$", body)
    if not m:
        print("[FAIL] body 搵唔到 `begin`")
        return False, 0
    body = body[m.end() :]
    checked = 0
    for stmt in split_statements(body):
        sql = to_sql(stmt)
        if sql is None:
            continue
        checked += 1
        try:
            parse_sql(sql)
            print(f"[ OK ] body 語句 #{checked}: {sql.splitlines()[0][:88]}")
        except Exception as exc:  # noqa: BLE001
            print(f"[FAIL] body 語句 #{checked}\n  {sql}\n  {type(exc).__name__}: {exc}")
            ok = False

    print(f"→ 驗咗 {checked} 條 body 語句")
    return ok, checked


def main() -> int:
    all_ok = True
    total = 0
    for p in SQL_PATHS:
        if not p.exists():
            print(f"\n=== {p.name} ===\n[SKIP] 檔案唔存在")
            continue
        ok, n = check_file(p)
        all_ok = all_ok and ok
        total += n

    print("\n" + "=" * 60)
    print("全部通過（語法層面）" if all_ok else "有語法錯誤，唔好貼上 production")
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
