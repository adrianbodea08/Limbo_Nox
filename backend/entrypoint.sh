#!/bin/sh
# Bring Nox's schema up to date, then start.
#
# NOX_DATABASE_URL unset is a legitimate state: Nox starts, every /api/nox route
# answers "not connected yet", and accounts still work. When a URL *is* set, a
# failed migration stops the container on purpose — booting on a half-applied
# schema is worse than not booting.
set -e

if [ -n "$NOX_DATABASE_URL" ] || [ -n "$TRACKER_DATABASE_URL" ]; then
  echo "nox: bringing the schema up to date…"
  alembic upgrade head
  echo "nox: schema up to date"
else
  echo "nox: no database configured — starting without one"
fi

exec "$@"
