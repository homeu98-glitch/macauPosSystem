"""離線 SQL 語法檢查（0066 驗收檔）。

用 pglast 逐個 parse，捉語法錯誤（唔會連資料庫）。
⚠️ 驗收檔放喺 supabase/verify/（唔係 migrations/）—— 佢係唯讀 SELECT、
   要 service role 先跑到；留喺 migrations/ 會被 db push 用 postgres role 執行而失敗。
2026-10-07 新增：驗收檔 supabase/verify/0066_verify_production_20261007.sql 用了 `set role` ＋
`reset role`，呢兩個係 psql/SQL-Eval 層級指令，pglast 會當成 syntax error
⇒ 本 checker 對該檔做「剝除 session 指令後再 parse」。
"""
import glob
import sys

try:
    from pglast import parse_sql
except ImportError:
    print("需要 pglast：pip install pglast")
    sys.exit(2)

# 會話層級指令：pglast 唔知，但 SQL Editor / psql 支援
SESSION_CMDS = ("set role", "reset role")

TARGETS = [
    "supabase/migrations/0066_pos_offline_report_channel.sql",
    "supabase/verify/0066_verify_production_20261007.sql",
]

# 順手埋其他 0058-0060（0066 嘅前身），確保基準未被污染
TARGETS += sorted(glob.glob("supabase/migrations/006[0-5]*.sql"))

fail = 0
for path in TARGETS:
    with open(path, encoding="utf-8") as f:
        src = f.read()

    # 剝除會話指令（逐行，唔理佢喺注释入面）
    lines = src.split("\n")
    kept = []
    for ln in lines:
        low = ln.strip().lower()
        if any(low.startswith(c) for c in SESSION_CMDS):
            continue
        kept.append(ln)
    stripped = "\n".join(kept)

    try:
        stmts = parse_sql(stripped)
        print(f"  OK  {len(stmts):2d} body  {path}")
    except Exception as exc:  # noqa: BLE001
        fail += 1
        print(f"  FAIL         {path}\n         {exc}")

sys.exit(1 if fail else 0)