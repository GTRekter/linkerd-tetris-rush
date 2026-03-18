# Tetris — Linkerd Multicluster Demo

An interactive Tetris game for demonstrating Linkerd multicluster capabilities at conferences and meetups.

Attendees scan a QR code, join from their phones, and play Tetris. Every piece is fetched via a real API call routed through Linkerd across Kubernetes clusters. The presenter switches between **5 live modules** — traffic splitting, latency injection, mTLS, authorization policy, and resiliency — each visibly affecting the pieces players receive in real time.

## The Core Metaphor

Each Tetris piece = one API request through the mesh.

```
Player requests next piece
        │
        ▼
   GET /api/next-piece
        │
   Linkerd Gateway
        │
   ┌────┴────┐────────┐
   │         │        │
 us-east  eu-west  ap-south
 (blue)   (purple)  (cyan)
```

The cluster badge on each piece shows which cluster served it. Latency, corruption, denial, and failover all manifest directly in the player's game.

## Modules

| Module | What it demos | What players see |
|---|---|---|
| **Traffic Split** | Request distribution across clusters | Piece colors shift as weights change |
| **Latency** | Latency injection & retries | Pieces stall at the top before spawning |
| **mTLS** | Mutual TLS & tampered requests | Pieces arrive as wrong shapes (corrupted) |
| **Auth Policy** | Authorization policies | "DENIED" in piece feed, Linkerd retries |
| **Resiliency** | Failover & cluster health | Cluster goes red on dashboard, game continues |

## Two Screens

**Player (phone via QR):**
- Scan → enter name → play Tetris immediately
- Each piece shows cluster badge and latency
- Touch controls: tap to rotate, swipe left/right to move, swipe down to hard drop
- Keyboard: arrow keys + space (desktop)

**Presenter (projected dashboard at `/dashboard`):**
- Live traffic flow diagram with animated requests
- Cluster cards with kill/revive, latency slider, and module-specific controls
- Real-time leaderboard
- Piece distribution chart (last 60s)
- Event log with per-cluster color coding
- QR code for attendees to scan

## Demo Flow (Suggested)

1. Show the QR, have everyone scan and start playing
2. **Traffic Split** — point out cluster badges on pieces; slide weights to 80% one cluster, watch piece colors shift
3. **Latency** — inject 800ms on one cluster; players served by it see a visible "Fetching piece..." pause
4. **mTLS** — disable mTLS; pieces start arriving as wrong shapes. Re-enable to fix instantly
5. **Auth Policy** — enable AuthPolicy; feed shows "DENIED" requests, Linkerd retries on authorized cluster
6. **Resiliency** — kill a cluster mid-game; pieces keep flowing (Linkerd failover), then revive and show recovery
7. Show the leaderboard

## Project Structure

```
.
├── api/
│   ├── main.py                 # FastAPI backend (piece serving, scoring, WebSockets)
│   ├── requirements.txt        # Python dependencies
│   └── Dockerfile              # API container image
├── tetris/
│   ├── client/                 # React frontend (player game)
│   │   └── src/
│   │       ├── pages/
│   │       │   ├── PlayerPage.js    # Tetris engine (board, controls, piece fetching)
│   │       │   └── DashboardPage.js # Presenter dashboard
│   │       └── components/     # Layout, NavigationBar, Footer
│   ├── server/                 # Express server (serves React build, proxies API/WS)
│   └── Dockerfile              # Tetris frontend container image
├── dashboard/
│   ├── client/                 # React frontend (presenter dashboard)
│   ├── server/                 # Express server (serves React build, proxies API/WS)
│   └── Dockerfile              # Dashboard container image
├── helm/
│   ├── tetris/                 # Helm chart
│   │   ├── Chart.yaml
│   │   ├── values.yaml         # Default values (us-east, ingress + TrafficSplit on)
│   │   └── templates/          # Namespace, Deployment, Service, Ingress, TrafficSplit
│   ├── values-us-east.yaml     # Primary cluster overrides
│   ├── values-eu-west.yaml     # Secondary cluster overrides
│   └── values-ap-south.yaml    # Secondary cluster overrides
├── scripts/
│   ├── local-dev.sh            # Local development modes
│   └── k3d.sh                  # Full k3d multicluster setup
└── docs/
    ├── local-development.md    # Local development guide (no Kubernetes)
    ├── k3d-deployment.md       # k3d + Linkerd multicluster setup guide
    └── modules.md              # Demo modules — what each showcases about Linkerd
```

## Quick Start (Local)

```bash
# Backend only (FastAPI on port 8000)
./scripts/local-dev.sh

# Backend + React dev server (hot reload on port 3000)
./scripts/local-dev.sh --ui

# Simulate 3 clusters locally (ports 8001, 8002, 8003)
./scripts/local-dev.sh --multi

# Docker build and run
./scripts/local-dev.sh --docker
```

Open `/play` on your phone (or browser) and `/dashboard` on the projector.

## Kubernetes with Linkerd Multicluster

```bash
export CTX_EAST=your-east-context
export CTX_WEST=your-west-context
export CTX_SOUTH=your-south-context
export REGISTRY=your-registry.com/username
./scripts/k3d.sh
```

For step-by-step details see [docs/k3d-deployment.md](docs/k3d-deployment.md).

## Architecture

Each cluster runs the same container: **Python FastAPI** (game logic, WebSocket) behind a **Node Express** server (serves React, proxies `/api/*` and `/ws/*`). Linkerd multicluster mirrors the service across all clusters; the `TrafficSplit` resource controls weight distribution.

The presenter dashboard connects directly to each cluster's WebSocket and aggregates events, leaderboard, and cluster metadata in one view.

## Configuration

| Env Variable | Description | Default |
|---|---|---|
| `CLUSTER_NAME` | Name shown on piece badges | `local-dev` |
| `CLUSTER_COLOR` | Hex color for this cluster | `#3b82f6` |
| `CLUSTER_REGION` | Region label | `localhost` |
| `EXTERNAL_URL` | Public URL for QR code | `http://localhost:8000` |
| `ADMIN_TOKEN` | Token for presenter controls | `demo-admin-2024` |

## API Reference

| Path | Method | Description |
|---|---|---|
| `/api/health` | GET | Health check (503 when killed) |
| `/api/info` | GET | Cluster metadata + module state |
| `/api/join` | POST | Join game with name |
| `/api/next-piece` | GET | Fetch next Tetris piece (the mesh call) |
| `/api/score` | POST | Submit lines cleared + level |
| `/api/leaderboard` | GET | Top scores |
| `/api/qr` | GET | QR code SVG pointing to `/play` |
| `/api/admin/toggle-health` | POST | Kill / revive cluster |
| `/api/admin/set-latency` | POST | Inject latency (0–3000ms) |
| `/api/admin/set-scenario` | POST | Switch active module |
| `/api/admin/toggle-mtls` | POST | Toggle mTLS + interceptor |
| `/api/admin/toggle-auth-policy` | POST | Toggle authorization policy |
| `/api/admin/toggle-egress` | POST | Toggle egress (bonus pieces) |
| `/api/admin/set-weights` | POST | Set traffic split weights |
| `/api/admin/reset` | POST | Reset all game state |
| `/ws/player` | WebSocket | Real-time player events |
| `/ws/dashboard` | WebSocket | Real-time dashboard feed |

## Linkerd Features Demonstrated

- **Service Mirroring** — label `mirror.linkerd.io/exported: "true"` makes the service visible to linked clusters
- **Traffic Splitting** — `TrafficSplit` resource distributes piece requests across local and mirrored services
- **Automatic mTLS** — all piece requests encrypted by default; disable to show interception (pieces arrive corrupted)
- **Authorization Policies** — restrict which clusters can serve piece requests; unauthorized clusters return 403
- **Failover & Resiliency** — kill a cluster; Linkerd reroutes piece requests to healthy clusters with no game interruption
- **Observability** — every piece request reports cluster, latency, mTLS status, and denial metadata



The Demo Arc (what the presenter walks through)
"Everyone scan the QR, start playing"
→ Dashboard lights up with incoming requests, cluster badges appear on pieces

Module 1 — Traffic Split

"Right now all 3 clusters are serving pieces equally. Watch what happens when I shift traffic..."
→ Slides weight to 80% us-east → players suddenly get mostly blue pieces

Module 2 — Latency

"Let me inject 800ms latency on eu-west..."
→ Players assigned to eu-west see a visible pause before their next piece spawns. Dashboard shows latency spike. Linkerd retries kick in.

Module 3 — Failover / Resiliency

"What if a cluster goes down mid-game?"
→ Kill eu-west → dashboard shows it go red → Linkerd reroutes → no player's game is interrupted

Module 4 — mTLS

"Without mTLS, someone on the network can intercept and tamper with requests"
→ Toggle mTLS off on one cluster → pieces from that cluster arrive scrambled/wrong shape
→ Toggle back on → pieces normalize instantly

Module 5 — Auth Policy

"Now let's lock down who can send pieces to certain players"
→ Restrict ap-south from serving pieces to a group of players → those requests get rejected, pieces stop coming from that cluster

Key Design Decisions
Question	Answer
Is Tetris multiplayer?	Each player has their own board — independent games, shared leaderboard
What triggers a mesh call?	Every piece request — GET /api/next-piece?player_id=...
How do players see the Linkerd effect?	Visual state on the piece (cluster badge, scrambled, delayed spawn)
Does the phone show metrics?	Minimal — just the cluster badge and maybe latency on the last piece
Is the presenter dashboard playable?	No — it's a control + visualization panel only
