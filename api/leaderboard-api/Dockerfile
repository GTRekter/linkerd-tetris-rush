# Build context: repo root
FROM python:3.12-slim
WORKDIR /app
COPY api/leaderboard-api/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY api/leaderboard-api/ .
EXPOSE 80
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "80"]
