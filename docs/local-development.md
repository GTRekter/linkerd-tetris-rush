# Local Development

Run Tetris without Kubernetes or Linkerd. Useful for iterating on the UI and game logic.

## Prerequisites

- [Python 3.10+](https://www.python.org/)
- [Node.js 20+](https://nodejs.org/) + yarn (`npm install -g yarn`)
- [Docker](https://docs.docker.com/get-docker/) — only needed for the container build mode

## Project layout

```
api/
├── tetris-api/
│   └── main.py          # FastAPI backend — game logic, piece serving, admin API
├── dashboard-api/
│   └── index.js         # Node/Express — cluster discovery, k8s scaling, QR redirect
tetris/
├── client/              # React frontend (player game)
│   └── src/
│       ├── pages/       # PlayerPage
│       ├── components/  # GameBoard, ScoreSidebar, PieceSidebar
│       ├── hooks/       # useGame
│       └── services/    # gameApi, gameEngine
├── server/
│   └── index.js         # Express — serves React build, proxies /api/* to tetris-api
dashboard/
├── client/              # React frontend (presenter dashboard)
│   └── src/
│       ├── pages/       # DashboardPage
│       ├── components/  # ClusterCard, TrafficCanvas, ScenarioTabs, QRCodeSidebar, …
│       └── services/    # dashboardApi
├── server/
│   └── index.js         # Express — serves React build, proxies /go, /admin/*, /api/*
helm/
└── tetris/              # Helm chart (all four components + Redis)
```

For a full architecture description, component details, request flows, and Redis data model see [architecture.md](architecture.md).

---

## 1. Backend only (API testing)

Start the FastAPI backend alone to test API endpoints and WebSocket events. There is no UI in this mode — use the React dev server (mode 2) if you need one.

```bash
# From the repo root
pip install -r api/requirements.txt
uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload
```

- API docs: http://localhost:8000/docs
- Health check: http://localhost:8000/api/health

---

## 2. Backend + React dev server (hot reload)

Runs the React dev server on port 3000 with hot reload. API calls are proxied to FastAPI on port 8000 via the `"proxy"` field in `tetris/client/package.json`.

**Terminal 1 — backend:**

```bash
pip install -r api/requirements.txt
uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload
```

**Terminal 2 — frontend:**

```bash
cd tetris/client
yarn install
yarn start
```

- React UI: http://localhost:3000
- FastAPI (direct): http://localhost:8000

API and WebSocket requests from the React app (`/api/*`, `/ws/*`) are automatically forwarded to port 8000 by the dev proxy.

Or use the convenience script, which does both:

```bash
./scripts/local-dev.sh --ui
```

---

## 3. Simulate multiple clusters locally

Run three backend instances on different ports to simulate a multicluster setup without Kubernetes. Each instance gets its own cluster identity (name, color, region).

```bash
./scripts/local-dev.sh --multi
```

This starts:

| Instance | URL                   | Cluster  | Color  |
|----------|-----------------------|----------|--------|
| Primary  | http://localhost:8001 | us-east  | blue   |
| Secondary| http://localhost:8002 | eu-west  | purple |
| Secondary| http://localhost:8003 | ap-south | cyan   |

Open the dashboard at http://localhost:8001/dashboard. The dashboard will auto-connect to the primary cluster. You can add the other two endpoints manually via the cluster sidebar to aggregate all three in one view.

This mode is useful for testing the dashboard's multi-cluster aggregation, event log coloring, and traffic visualization — without needing Linkerd.

> **Note:** Traffic splitting does not happen in this mode. Piece requests always go to the cluster whose URL you hit directly. To test actual TrafficSplit behavior, use the [k3d deployment](k3d-deployment.md).

---

## 4. Docker build and run

Build the production multi-stage image (React + Express + FastAPI) and run it locally.

```bash
# Build
docker build -t tetris:local -f tetris/Dockerfile .

# Run
docker run --rm \
  -p 8080:80 \
  -p 8000:8000 \
  -e CLUSTER_NAME=local-dev \
  -e CLUSTER_COLOR="#3b82f6" \
  -e CLUSTER_REGION=local \
  -e EXTERNAL_URL=http://localhost:8080 \
  -e ADMIN_TOKEN=demo-admin-2024 \
  tetris:local
```

- React UI (via Express): http://localhost:8080
- FastAPI (direct): http://localhost:8000

Or use the script:

```bash
./scripts/local-dev.sh --docker
```

The Dockerfile is a two-stage build: stage 1 builds the React app with Node 20; stage 2 produces a lean runtime that runs the Express server (port 80).

---

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `CLUSTER_NAME` | Name shown on piece badges and cluster cards | `local-dev` |
| `CLUSTER_COLOR` | Hex color for this cluster | `#3b82f6` |
| `CLUSTER_REGION` | Region label shown in the UI | `localhost` |
| `EXTERNAL_URL` | Public URL of this cluster's tetris-frontend | `http://localhost:8000` |
| `DASHBOARD_URL` | Public URL of the dashboard (for QR code + `/go` redirect) | `http://localhost:8001` |
| `ADMIN_TOKEN` | Token required for all `/api/admin/*` calls | `demo-admin-2024` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |

For the full environment variable reference (all components) see [architecture.md](architecture.md).

---

## API reference

### tetris-api endpoints

| Path | Method | Description |
|---|---|---|
| `/api/health` | GET | Health check — returns 503 when the cluster is "killed" |
| `/api/info` | GET | Cluster identity, health, active scenario, and module state |
| `/api/join` | POST | Register a player by name; returns `player_id` |
| `/api/next-piece` | GET | Fetch the next Tetris piece — the core mesh call |
| `/api/score` | POST | Submit lines cleared and level after each piece locks |
| `/api/leaderboard` | GET | Top 20 players sorted by score |
| `/api/qr` | GET | SVG QR code pointing to the dashboard's `/go` redirect |
| `/api/admin/toggle-health` | POST | Kill or revive this cluster instance |
| `/api/admin/set-latency` | POST | Inject artificial latency in milliseconds (0–3000) |
| `/api/admin/set-scenario` | POST | Switch the active demo module |
| `/api/admin/toggle-mtls` | POST | Toggle mTLS; when off, pieces are corrupted in transit |
| `/api/admin/toggle-auth-policy` | POST | Toggle AuthorizationPolicy; 35% of requests denied |
| `/api/admin/toggle-egress` | POST | Toggle egress bonus pieces |
| `/api/admin/set-weights` | POST | Update traffic split weights (informational — Linkerd controls actual routing) |
| `/api/admin/reset` | POST | Clear all players, scores, and stats |

### dashboard-api endpoints

| Path | Method | Description |
|---|---|---|
| `/go` | GET | Round-robin redirect — distributes QR scanners across cluster frontends |
| `/api/clusters` | GET | List all discovered clusters with identity and external URL |
| `/api/info-all` | GET | Aggregated info for all clusters |
| `/api/qr` | GET | SVG QR code pointing to `/go` |
| `/api/leaderboard` | GET | Top 20 players by score |
| `/api/admin/*` | POST | Admin write endpoints (same as tetris-api, but targets any cluster) |
| `/admin/scale-down` | POST | Scale a cluster's tetris-api to 0 replicas |
| `/admin/scale-up` | POST | Scale a cluster's tetris-api back up |

All admin endpoints require `{ "token": "<ADMIN_TOKEN>" }` in the request body.

For the complete Redis data model, request flow diagrams, and component architecture see [architecture.md](architecture.md).
