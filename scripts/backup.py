#!/usr/bin/env python3
"""Take a backup of everything Nox knows.

    python scripts/backup.py                 -> ./backups/nox-<utc>.tar.gz
    python scripts/backup.py --out /somewhere
    python scripts/backup.py --keep 10       -> and prune older ones

One database, one dump. It used to be two — accounts lived in a separate SQLite
file — and this script carried a long note about WAL mode, about never copying
that file, and about which of the two had to be captured first so that a race
between them healed itself rather than orphaning somebody.

All of that went away on 2026-08-22 when the accounts moved into Postgres. The
note is worth remembering as the reason the split was worth ending: a backup of
two stores is not a backup of one system, because nothing makes the two
snapshots agree.
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



def counts() -> dict:
    """A few numbers, so a restore can be checked against what was taken rather
    than against somebody's memory of it."""
    got: dict[str, int] = {}
    try:
        out = compose(
            "exec", "-T", DB_SERVICE, "psql", "-U", PG_USER, "-d", PG_DB, "-tAc",
            "SELECT (SELECT count(*) FROM issues) || ',' || (SELECT count(*) FROM events)"
            " || ',' || (SELECT count(*) FROM users) || ','"
            " || (SELECT count(*) FROM users WHERE username IS NOT NULL)",
            capture_output=True, text=True).stdout.strip()
        issues, events, people, accounts = (int(x) for x in out.split(","))
        got.update(issues=issues, events=events, people=people, accounts=accounts)
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
        print("  dumping …", flush=True)
        dump_tracker(work / "nox.dump")

        manifest = {
            "taken_at": datetime.now(timezone.utc).isoformat(),
            "counts": counts(),
            "note": "One database since 2026-08-22 — accounts are in Postgres too.",
        }
        (work / "manifest.json").write_text(json.dumps(manifest, indent=2))

        with tarfile.open(archive, "w:gz") as tar:
            for name in ("nox.dump", "manifest.json"):
                tar.add(work / name, arcname=name)

    inside = verify(archive)
    if set(inside) != {"nox.dump", "manifest.json"}:
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
