# ELIAS-Interviewer, built by STELLA from the uploaded package (build context = package root).
FROM python:3.12-slim

WORKDIR /app

# libglib2.0-0 provides libgobject-2.0.so, which livekit-rtc needs.
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY src /app/src
ENV PYTHONPATH=/app/src \
    PYTHONUNBUFFERED=1

# STELLA runs pods as uid 1000.
USER 1000

CMD ["python", "-m", "elias_interviewer"]
