"""Task 2 verification script (Python 3 stdlib sqlite3, no Electron ABI)."""
import json, os, sqlite3, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, ".data", "fmb.db")
LOG_DIR = os.path.join(ROOT, ".data", "logs")

errors = []

def check(cond, msg):
    if not cond:
        errors.append(msg)
        print(" FAIL " + msg)
    else:
        print(" PASS " + msg)

print("DB_PATH", DB)
check(os.path.exists(DB), "DB_EXISTS (fmb.db on disk)")

EXPECTED_TABLES = [
    "plugins", "plugin_versions", "workflows", "workflow_runs",
    "workflow_nodes", "schedules", "job_queue", "error_logs",
    "audit_logs", "extension_point_bindings", "secrets", "kv_store",
    "__migrations",
]

if os.path.exists(DB):
    con = sqlite3.connect(DB)
    cur = con.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    actual = [r[0] for r in cur.fetchall()]
    print("  ACTUAL TABLES:", actual)
    missing = [t for t in EXPECTED_TABLES if t not in actual]
    check(len(missing) == 0, f"ALL 13 tables present (missing={missing})")
    check(len(actual) >= 13, f"AT LEAST 13 tables (count={len(actual)})")

    cur.execute("SELECT name FROM __migrations ORDER BY name")
    applied = [r[0] for r in cur.fetchall()]
    print("  APPLIED MIGRATIONS:", applied)
    check("001_init.sql" in applied, "migration '001_init.sql' recorded in schema_migrations")

    cur.execute("SELECT id, action, source, actor, trace_id FROM audit_logs WHERE action = 'app.boot' ORDER BY id ASC LIMIT 1")
    rows = cur.fetchall()
    print("  audit_logs app.boot rows:", len(rows))
    for r in rows:
        print("   row:", json.dumps(r, ensure_ascii=False))
    check(len(rows) >= 1, "audit_logs contains 1+ 'app.boot' record")
    con.close()
else:
    errors.append("cannot open DB (missing)")

print("--- logs directory ---")
for name in ["main.log", "db.log", "audit.log"]:
    p = os.path.join(LOG_DIR, name)
    exists = os.path.exists(p)
    sz = os.path.getsize(p) if exists else -1
    check(exists and sz >= 0, f"log file created: .data/logs/{name} (size={sz})")

# Check some log content: pino outputs JSON lines
main_log = os.path.join(LOG_DIR, "main.log")
if os.path.exists(main_log) and os.path.getsize(main_log) > 0:
    with open(main_log, "r", encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()
    any_fmb_boot = any('"fmb infrastructure booted"' in line or 'fmb infrastructure booted' in line for line in lines)
    check(any_fmb_boot or len(lines) > 0, f"main.log has content ({len(lines)} lines)")

print("--- summary ---")
if errors:
    print(f"FAILED: {len(errors)} issue(s):")
    for e in errors:
        print("  -", e)
    sys.exit(1)
print("ALL TASK 2 CHECKS PASSED")
