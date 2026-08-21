# ---- Nox by Limbo — API (FastAPI + uvicorn) ----
FROM python:3.12-slim

# No .pyc, unbuffered stdout so `docker logs` is live. Everything — the work and
# the accounts alike — lives in Postgres; there was a second, SQLite store for
# accounts until 2026-08-22.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Dependencies first, so this layer is cached until requirements change.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# The test runner, only when asked for. A container that runs the app has no
# business carrying pytest, and installing it per test run instead would cost
# five seconds every time somebody wanted to know whether they had broken
# something — which is the tax that stops people running tests.
ARG WITH_TESTS=0
RUN if [ "$WITH_TESTS" = "1" ]; then pip install --no-cache-dir pytest==8.3.4; fi

COPY app ./app

# Migrations run at boot, but only when a database is configured — see
# entrypoint.sh.
COPY alembic.ini ./
COPY alembic ./alembic
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Unprivileged.
RUN useradd --create-home --uid 10001 nox \
    && chown -R nox:nox /app
USER nox

EXPOSE 8200

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8200/api/health')"

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8200"]
