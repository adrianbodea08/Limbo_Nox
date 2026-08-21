#!/usr/bin/env python3
"""Take a backup of everything Nox knows.

    python scripts/backup.py                 -> ./backups/nox-<utc>.tar.gz
    python scripts/backup.py --out /somewhere
    python scripts/backup.py --keep 10       -> and prune older ones

Two stores, and both have to come along:

    tracker.dump    Postgres — issues, events, releases, git refs. The work.
    accounts.db     SQLite   — who everybody is. 45 KB, and the only copy.

The small one is the frightening one. It is small enough to look unimportant
and losing it means nobody can sign in to the work that survived.

**Never `cp` the SQLite file.** It runs in WAL mode, and at the time of writing
the write-ahead log was *larger than the database* — 53 KB against 45 KB. A file
copy takes the main database and leaves the recent half of the transactions
behind, producing a backup that restores cleanly, looks fine, and is silently
weeks out of date. `sqlite3.Connection.backup()` is the online-backup API: it
walks pages under a read lock and cooperates with the running app, so the result
is a real point-in-time copy of a database that is still being written to.

**Postgres first, then accounts, and the order is load-bearing.** There is no
transaction spanning two databases, so a few seconds separate the two snapshots.
Taking Postgres first means an account created in that window ends up in the
accounts file with no tracker row — and `api.py:_project_user` writes that row
on the way past, so it heals itself the first time that person clicks anything.
The other order leaves a tracker person with no account behind them, which
nothing repairs.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# What the compose file calls things. Kept here rather than guessed at runtime
# so a rename fails loudly instead of backing up nothing.
DB_SERVICE = "db"
API_SERVICE = "api"
PG_USER = "nox"
PG_DB = "nox"
ACCOUNTS_PATH = "/data/nox.db"


def run(args: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=ROOT, check=True, **kw)


def compose(*args: str, **kw) -> subprocess.CompletedProcess:
    return run(["docker", "compose", *args], **kw)


def dump_tracker(into: Path) -> None:
    """Custom format: compressed, and `pg_restore` can be selective about it if
    somebody ever needs one table back rather than the lot."""
    with open(into, "wb") as out:
        compose("exec", "-T", DB_SERVICE,
                "pg_dump", "-Fc", "-U", PG_USER, "-d", PG_DB, stdout=out)
    if into.stat().st_size == 0:
        raise SystemExit("the tracker dump came out empty — refusing to write a backup")


def dump_accounts(into: Path) -> None:
    """Through SQLite's own backup API, for the reason in the module docstring."""
    inside = "/tmp/nox-accounts-backup.db"
    script = (
        "import sqlite3;"
        f"src = sqlite3.connect('{ACCOUNTS_PATH}');"
        f"dst = sqlite3.connect('{inside}');"
        "src.backup(dst);"
        "dst.close(); src.close()"
    )
    compose("exec", "-T", API_SERVICE, "python", "-c", script)
    compose("cp", f"{API_SERVICE}:{inside}", str(into))
    # Not left lying around inside the container, where the next backup would
    # copy a stale one if the snapshot step ever failed silently.
    compose("exec", "-T", API_SERVICE, "rm", "-f", inside)
    if into.stat().st_size == 0:
        raise SystemExit("the accounts snapshot came out empty — refusing to write a backup")


def counts() -> dict:
    """A few numbers, so a restore can be checked against what was taken rather
    than against somebody's memory of it."""
    got: dict[str, int] = {}
    try:
        out = compose(
            "exec", "-T", DB_SERVICE, "psql", "-U", PG_USER, "-d", PG_DB, "-tAc",
            "SELECT (SELECT count(*) FROM issues) || ',' || (SELECT count(*) FROM events)"
            " || ',' || (SELECT count(*) FROM users)",
            capture_output=True, text=True).stdout.strip()
        issues, events, people = (int(x) for x in out.split(","))
        got.update(issues=issues, events=events, tracker_people=people)
    except Exception:
        pass
    try:
        out = compose(
            "exec", "-T", API_SERVICE, "python", "-c",
            f"import sqlite3;print(sqlite3.connect('{ACCOUNTS_PATH}')"
            ".execute('SELECT count(*) FROM users').fetchone()[0])",
            capture_output=True, text=True).stdout.strip()
        got["accounts"] = int(out)
    except Exception:
        pass
    return got


def verify(archive: Path) -> list[str]:
    """Open it again and look. A backup nobody has read is a hope."""
    with tarfile.open(archive, "r:gz") as tar:
        return sorted(m.name for m in tar.getmembers() if m.isfile())


def main() -> int:
    ap = argparse.ArgumentParser(description="Back up Nox.")
    ap.add_argument("--out", default=str(ROOT / "backups"),
                    help="where the archive goes (default ./backups)")
    ap.add_argument("--keep", type=int, default=0,
                    help="keep only the newest N and delete the rest (default: keep all)")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive = out_dir / f"nox-{stamp}.tar.gz"

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        print("  tracker  (postgres) …", flush=True)
        dump_tracker(work / "tracker.dump")
        print("  accounts (sqlite)   …", flush=True)
        dump_accounts(work / "accounts.db")

        manifest = {
            "taken_at": datetime.now(timezone.utc).isoformat(),
            "counts": counts(),
            "note": "Postgres was captured first; see scripts/backup.py for why.",
        }
        (work / "manifest.json").write_text(json.dumps(manifest, indent=2))

        with tarfile.open(archive, "w:gz") as tar:
            for name in ("tracker.dump", "accounts.db", "manifest.json"):
                tar.add(work / name, arcname=name)

    inside = verify(archive)
    if set(inside) != {"tracker.dump", "accounts.db", "manifest.json"}:
        raise SystemExit(f"the archive is missing something: {inside}")

    size = archive.stat().st_size
    print(f"\n  {archive}")
    print(f"  {size / 1024:.0f} KB · {', '.join(inside)}")
    for k, v in (manifest["counts"] or {}).items():
        print(f"    {k}: {v}")

    if args.keep > 0:
        old = sorted(out_dir.glob("nox-*.tar.gz"))[:-args.keep]
        for path in old:
            path.unlink()
        if old:
            print(f"  pruned {len(old)} older")

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as e:
        print(f"\n  a step failed: {' '.join(e.cmd)}", file=sys.stderr)
        sys.exit(1)
