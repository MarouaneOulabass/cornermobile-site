# API and worker image. Build from the repository root: docker build -f backend/Dockerfile .
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

# WeasyPrint (PDF report) needs Pango and HarfBuzz; DejaVu fonts for the PDF report.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpango-1.0-0 libpangoft2-1.0-0 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /usr/local/bin/uv

WORKDIR /srv/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --locked --no-dev --extra anthropic --no-install-project
COPY backend/ ./
COPY demo-data /srv/demo-data
RUN uv sync --locked --no-dev --extra anthropic --no-editable

ENV PATH=/srv/backend/.venv/bin:$PATH \
    AUDITFLOW_ENV=prod \
    AUDITFLOW_STORAGE_DIR=/srv/var/storage

RUN useradd --uid 10001 --create-home auditflow && mkdir -p /srv/var/storage && chown -R auditflow /srv/var
USER auditflow

EXPOSE 8000
# Single API replica migrates on start; with several replicas, run `alembic upgrade head` as a release step instead.
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'"]
