# ---- Nox by Limbo — API (FastAPI + uvicorn) ----
FROM python:3.12-slim

# No .pyc, unbuffered stdout so `docker logs` is live. Accounts live in SQLite
# on the mounted volume; everything Nox tracks lives in Postgres.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NOX_AUTH_DB_PATH=/data/nox.db

WORKDIR /app

# Dependencies first, so this layer is cached until requirements change.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Migrations run at boot, but only when a database is configured — see
# entrypoint.sh.
COPY alembic.ini ./
COPY alembic ./alembic
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Unprivileged. The app user owns /data, where the accounts database lives.
RUN useradd --create-home --uid 10001 nox \
    && mkdir -p /data \
    && chown -R nox:nox /app /data
USER nox

EXPOSE 8200

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8200/api/health')"

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8200"]
