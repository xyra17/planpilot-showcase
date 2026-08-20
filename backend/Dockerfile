FROM python:3.12-slim

USER root
WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN getent group planpilot >/dev/null || groupadd --system planpilot; \
    id -u planpilot >/dev/null 2>&1 || useradd --system --gid planpilot --create-home planpilot
COPY --chown=planpilot:planpilot . .
RUN mkdir -p /app/uploads/avatars && chown -R planpilot:planpilot /app/uploads

USER planpilot

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
