"""臨時驗收工具：用 libpg_query（pglast）驗證 docs/sql/94-ledger-report-api.sql 嘅語法。

本機冇 Postgres，呢個 script 用 PostgreSQL 真正嘅 grammar 解析器（libpg_query）
做語法層面驗收，捕捉括號／CTE／aggregate 語法錯誤。

用法：
  <venv>/Scripts/python.exe tools/check-94-sql.py

⚠️ 只驗語法，唔驗執行期（欄位名／型別要喺 Supabase SQL Editor 實跑先驗到）。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    from pglast import parse_sql
except ImportError:
    sys.exit("需要 pglast：pip install pglast")

ROOT = Path(__file__).resolve().parent.parent
SQL_PATH = ROOT / "docs" / "sql" / "94-ledger-report-api.sql"

DYN_VAR = {
    "p_store_id": "'macau-store-a'",
    "v_from_req": "date '2026-08-01'",
    "v_to_req": "date '2026-08-30'",
    "v_from": "date '2026-08-01'",
    "v_to": "date '2026-08-30'",
    "v_days": "30",
    "v_clamped": "false",
    "v_max_days": "90",
    "v_top_n": "50",
    "v_gaps": "'[]'::jsonb",
    "k_unavail_rules": "'[]'::jsonb",
    "k_version": "'1.0'",
    "k_tz": "'Asia/Macau'",
}


def sub_vars(sql: str) -> str:
    for name, lit in DYN_VAR.items():
        sql = re.sub(rf"(?<![\w$]){name}(?![\w$])", lit, sql)
    return sql


def check(label: str, sql: str) -> bool:
    sql = sql.strip()
    if not sql:
        print(f"[SKIP] {label}: 搵唔到")
        return True
    try:
        parse_sql(sql)
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] {label}\n  {type(exc).__name__}: {exc}")
        return False
    print(f"[ OK ] {label}")
    return True


def main() -> int:
    src = SQL_PATH.read_text(encoding="utf-8")
    ok = True

    # 1) 成個檔案（plpgsql body 係字串，libpg_query 唔會入去驗）
    ok &= check("成個 SQL 檔案（外層語句）", src)

    # 2) 主查詢：由 `with o as (` 去到 `into v_result`，剝走 plpgsql 嘅 INTO
    m = re.search(r"(with\s+o\s+as\s+\(.*?\)\s*\n\s*select\s+jsonb_build_object\()", src, re.S)
    if m:
        start = m.start(1)
        end = src.index("into v_result", start)
        main_q = src[start:end].strip()
        main_q = sub_vars(main_q)
        ok &= check("主查詢（with ... select jsonb_build_object）", main_q)
    else:
        print("[FAIL] 搵唔到主查詢起點")
        ok = False

    # 3) 兩段 dynamic SQL（EXECUTE $q$ ... $q$）
    for i, m in enumerate(re.finditer(r"execute\s+\$q\$(.*?)\$q\$", src, re.S), start=1):
        ok &= check(f"dynamic SQL #{i}", m.group(1))

    print("\n" + ("全部通過（語法層面）" if ok else "有語法錯誤，唔好貼上 production"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
