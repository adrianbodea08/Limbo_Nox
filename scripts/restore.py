#!/usr/bin/env python3
"""Put a backup back.

    python scripts/restore.py backups/nox-20260822T101500Z.tar.gz --yes

**This replaces everything.** Every issue, every event, every account, every
session, rebuilt from the archive. There is no merge and no undo, which is why
`--yes` is required and why the manifest is printed before anything happens.

Without `--yes` it stops after reading the manifest, which is also how to see
what is in an archive without unpacking it by hand.

**The api is stopped while this runs**, so nothing is writing rows while
`pg_restore` drops the tables under it.

One store since 2026-08-22. The version of this that handled two also had to
chown a file afterwards, because `docker compose cp` writes as root and SQLite
opens a file it cannot write as *readonly* rather than failing — which came back
as a container crash-looping on "attempt to write a readonly database". Found by
restoring, which remains the only way that kind of thing is ever found.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DB_SERVICE = "db"
API_SERVICE = "api"
PG_USER = "nox"
PG_DB = "nox"


def compose(*args: str, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", "compose", *args], cwd=ROOT, check=True, **kw)


def read_manifest(archive: Path) -> dict:
    with tarfile.open(archive, "r:gz") as tar:
        member = tar.extractfile("manifest.json")
        if member is None:
            raise SystemExit("that archive has no manifest — it is not one of ours")
        return json.load(member)


def main() -> int:
    ap = argparse.ArgumentParser(description="Restore Nox from a backup.")
    ap.add_argument("archive")
    ap.add_argument("--yes", action="store_true",
                    help="actually do it — without this the script only reports")
    args = ap.parse_args()

    archive = Path(args.archive)
    if not archive.exists():
        raise SystemExit(f"no such archive: {archive}")

    manifest = read_manifest(archive)
    print(f"  taken   {manifest.get('taken_at', 'unknown')}")
    for key, value in (manifest.get("counts") or {}).items():
        print(f"    {key}: {value}")

    if not args.yes:
        print("\n  Nothing changed. Pass --yes to replace everything with this.")
        return 0

    print("\n  stopping the api …", flush=True)
    compose("stop", API_SERVICE)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            with tarfile.open(archive, "r:gz") as tar:
                tar.extractall(work)

            # An archive taken before the accounts moved has a different shape.
            # Saying so is kinder than a confusing failure three steps later.
            dump = work / "nox.dump"
            if not dump.exists():
                if (work / "tracker.dump").exists():
                    raise SystemExit(
                        "that archive predates the accounts moving into Postgres "
                        "(it has tracker.dump and accounts.db). Restoring it needs "
                        "the code from before 2026-08-22.")
                raise SystemExit("that archive has no dump in it")

            print("  restoring …", flush=True)
            # --clean --if-exists so a restore over a populated database
            # replaces it rather than colliding with every primary key.
            with open(dump, "rb") as src:
                subprocess.run(
                    ["docker", "compose", "exec", "-T", DB_SERVICE,
                     "pg_restore", "--clean", "--if-exists", "--no-owner",
                     "-U", PG_USER, "-d", PG_DB],
                    cwd=ROOT, stdin=src, check=True)
    finally:
        print("  starting the api …", flush=True)
        compose("start", API_SERVICE)

    print("\n  Restored. Check the counts above against what the app now says.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as e:
        print(f"\n  a step failed: {' '.join(e.cmd)}", file=sys.stderr)
        print("  the api may still be stopped — `docker compose start api`", file=sys.stderr)
        sys.exit(1)
