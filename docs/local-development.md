# Local Development

This guide covers running Tetris Rush locally without Kubernetes for frontend and backend development.

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Python | 3.12+ | tetris-api backend |
| Node.js | 20+ | Frontend dev servers and dashboard-api |
| Yarn | 1.x | Frontend dependency management |
| Docker | Any | Redis container |

---

## Quick Start

```bash
./scripts/local-dev.sh
```

This launches an interactive prompt to choose between the Tetris game frontend or the Dashboard frontend, then starts the backend and a React dev server with hot reload.

---

## Development Modes

### Interactive (default)

```bash
./scripts/local-dev.sh
```

Prompts you to choose:
1. **Tetris** — game frontend on port 3000 + backend on port 8000
2. **Dashboard** — presenter frontend on port 3000 + backend on port 8000

### Tetris Frontend

```bash
./scripts/local-dev.sh --ui
```

| Service | URL |
|---------|-----|
| React dev server (hot reload) | `http://localhost:3000` |
| tetris-api backend | `http://localhost:8000` |

### Dashboard Frontend

```bash
./scripts/local-dev.sh --dashboard
```

| Service | URL |
|---------|-----|
| React dev server (hot reload) | `http://localhost:3000` |
| tetris-api backend | `http://localhost:8000` |

### Multi-Cluster Simulation

```bash
./scripts/local-dev.sh --multi
```

Runs three tetris-api instances simulating different clusters:

| Cluster | URL | Color |
|---------|-----|-------|
| us-east | `http://localhost:8001` | Blue (`#3b82f6`) |
| eu-west | `http://localhost:8002` | Purple (`#8b5cf6`) |
| ap-south | `http://localhost:8003` | Cyan (`#06b6d4`) |

This mode is backend-only — no React dev server. Useful for testing multi-cluster piece distribution and admin API calls.

### Docker

```bash
./scripts/local-dev.sh --docker
```

Builds the production Docker image and runs it locally:

| Service | URL |
|---------|-----|
| Tetris UI | `http://localhost:8080` |
| tetris-api | `http://localhost:8000` |

---

## Manual Setup

If you prefer to run components individually:

### 1. Start Redis

```bash
docker run -d --name tetris-redis -p 6379:6379 redis:alpine
```

### 2. Start tetris-api

```bash
cd api/tetris-api
python3 -m venv ../../.venv
source ../../.venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### 3. Start a frontend dev server

For the Tetris game:

```bash
cd tetris/client
yarn install
yarn start
```

For the Dashboard:

```bash
cd dashboard/client
yarn install
yarn start
```

Both React apps start on port 3000 with hot reload.

### 4. Start dashboard-api (optional)

Only needed if you're working on the dashboard and need cluster info, scaling, or admin endpoints:

```bash
cd api/dashboard-api
npm install
node index.js
```

---

## Environment Variables

Override these to customize local behavior:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLUSTER_NAME` | `local-dev` | Cluster name shown in piece badges |
| `CLUSTER_COLOR` | `#3b82f6` | Hex color for this cluster |
| `CLUSTER_REGION` | `localhost` | Region label in the UI |
| `EXTERNAL_URL` | `http://localhost:8000` | Public URL for QR code generation |
| `ADMIN_TOKEN` | `demo-admin-2024` | Token for admin API calls |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |

---

## Testing API Endpoints

### Join as a player

```bash
curl -X POST http://localhost:8000/api/join \
  -H 'Content-Type: application/json' \
  -d '{"name": "TestPlayer"}'
```

### Fetch a piece

```bash
curl "http://localhost:8000/api/next-piece?player_id=<PLAYER_ID>"
```

### Submit a score

```bash
curl -X POST http://localhost:8000/api/score \
  -H 'Content-Type: application/json' \
  -d '{"player_id": "<PLAYER_ID>", "lines_cleared": 2, "level": 1}'
```

### Toggle mTLS (admin)

```bash
curl -X POST http://localhost:8000/api/admin/toggle-mtls \
  -H 'Content-Type: application/json' \
  -d '{"token": "demo-admin-2024"}'
```

### Get leaderboard

```bash
curl http://localhost:8000/api/leaderboard
```

---

## Project Structure for Development

```
tetris/client/src/
├── components/
│   ├── GameBoard.js      # 10x20 Tetris board renderer
│   ├── PieceSidebar.js   # Next piece preview and feed
│   └── ScoreSidebar.js   # Score, level, lines display
├── hooks/
│   └── useGame.js        # Core game loop and piece fetching
├── pages/
│   └── PlayerPage.js     # Main player page
└── services/
    └── gameEngine.js     # Rotation, collision, line clearing

dashboard/client/src/
├── components/
│   └── ClusterCard.js    # Per-cluster controls and stats
├── pages/
│   └── DashboardPage.js  # Main presenter dashboard
└── services/
    └── dashboardApi.js   # API client for dashboard-api
```

---

## Debugging

### Redis state inspection

```bash
docker exec -it tetris-redis redis-cli

# View all cluster keys
KEYS *:game:*

# Check game state for local-dev
HGETALL local-dev:game:state

# View active players
SMEMBERS global:players

# Check a specific player
HGETALL global:player:<PLAYER_ID>
```

### Backend logs

The `--reload` flag on uvicorn enables auto-restart on file changes. Logs are printed to stdout with request details.

### Frontend proxy issues

The React dev server proxies `/api/*` requests to the backend. If you see CORS errors, ensure the backend is running on the expected port (8000 by default). The tetris-api has CORS set to allow all origins in development.
