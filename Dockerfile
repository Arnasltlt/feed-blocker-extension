FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

COPY server.py .

EXPOSE 8080

CMD ["sh", "-c", "gunicorn -b 0.0.0.0:${PORT:-8080} -w 1 server:app"]
