#!/usr/bin/env python3
"""Put a backup back.

    python scripts/restore.py backups/nox-20260822T101500Z.tar.gz --yes

**This replaces everything.** Both stores are wiped and rebuilt from the
archive: every issue, every event, every account, every session. There is no
merge and there is no undo, which is why `--yes` is required and why the script
prints what it is about to overwrite before it does it.

Without `--yes` it stops after reading the manifest, which is also how you check
what is in an archive without unpacking it by hand.

**The api is stopped while this runs.** The accounts file is SQLite and the
application holds it open; writing over a database somebody else has a
connection to is how you get a file that is neither the old one nor the new one.
Postgres does not need it, but stopping the api also means nothing is writing
tracker rows while `pg_restore` drops the tables under it.
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
ACCOUNTS_PATH = "/data/nox.db"


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

            print("  tracker  (postgres) …", flush=True)
            # --clean --if-exists so a restore over a populated database
            # replaces it rather than colliding with every primary key.
            with open(work / "tracker.dump", "rb") as src:
                subprocess.run(
                    ["docker", "compose", "exec", "-T", DB_SERVICE,
                     "pg_restore", "--clean", "--if-exists", "--no-owner",
                     "-U", PG_USER, "-d", PG_DB],
                    cwd=ROOT, stdin=src, check=True)

            print("  accounts (sqlite)   …", flush=True)
            # Straight over the top, which is safe *because the api is stopped*.
            compose("cp", str(work / "accounts.db"), f"{API_SERVICE}:{ACCOUNTS_PATH}")

            # `docker compose cp` writes as root; the app runs as its own user
            # and SQLite opens a file it cannot write as *readonly* rather than
            # failing — so the container came back up and crash-looped on
            # "attempt to write a readonly database". Found by restoring, which
            # is the only way this kind of thing is ever found.
            #
            # The WAL and shared-memory files belong to the database that was
            # just replaced. Left behind, SQLite tries to replay a log against a
            # file it does not match.
            compose("run", "--rm", "-T", "--user", "root", "--entrypoint", "sh",
                    API_SERVICE, "-c",
                    f"rm -f {ACCOUNTS_PATH}-wal {ACCOUNTS_PATH}-shm && "
                    f"chown --reference=/data {ACCOUNTS_PATH} && "
                    f"chmod 644 {ACCOUNTS_PATH}")
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
