FROM python:3.11-slim
WORKDIR /app
COPY requirements_cron.txt .
RUN pip install --no-cache-dir -r requirements_cron.txt
COPY fire_calls.py .
CMD ["python", "fire_calls.py"]
