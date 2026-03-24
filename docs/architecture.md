# Architecture

This document describes the system architecture, component interactions, request flows, and Redis data model for the Tetris Rush multicluster demo.

---

## High-Level Overview

Tetris Rush is a six-component system deployed across five domain-based Kubernetes clusters, connected by Linkerd's multicluster service mesh. A shared Redis instance on the scoring cluster provides cross-cluster state synchronization.

```
┌────────────────────────────────────────────────────────────────────┐
│                      k3d-platform                                  │
│                                                                    │
│  ┌────────────────────┐     ┌──────────────────┐                   │
│  │   dashboard        │────▶│      agent       │                   │
│  │ (React + Express)  │     │ (Node/Express)   │                   │
│  └────────────────────┘     └────────┬─────────┘                   │
│         ▲ presenter                  │                             │
│         │ browser                    │ reads Redis, proxies to     │
│                                      │ gameplay agents via mesh    │
│                                      ▼                             │
│                         leaderboard-api-scoring                    │
│                         (cross-cluster via mesh)                   │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────┐  ┌─────────────────────┐  ┌──────────────────────────┐
│   k3d-gameplay-east    │  │  k3d-gameplay-west  │  │  k3d-gameplay-central    │
│                        │  │                     │  │                          │
│ ┌──────────┐ ┌───────┐│  │┌──────────┐┌──────┐│  │┌──────────┐ ┌───────────┐│
│ │   game   ├▶│game-  ││  ││   game   ├▶│game- ││  ││   game   ├▶│  game-    ││
│ │(React+   │ │ api   ││  ││(React+   │ │ api  ││  ││(React+   │ │   api     ││
│ │Express)  │ │(Fast  ││  ││Express)  │ │(Fast ││  ││Express)  │ │ (FastAPI) ││
│ └──────────┘ │ API)  ││  │└──────────┘ │ API) ││  │└──────────┘ └───────────┘│
│              └───┬───┘│  │             └──┬───┘│  │                          │
│  ┌───────────┐   │    │  │ ┌───────────┐  │   │  │ ┌───────────┐            │
│  │   agent   │   │    │  │ │   agent   │  │   │  │ │   agent   │            │
│  └───────────┘   │    │  │ └───────────┘  │   │  │ └───────────┘            │
│                  ▼    │  │                ▼   │  │                          │
│  leaderboard-api ──►  │  │ leaderboard-api►  │  │  leaderboard-api ──►     │
│  scoring cluster      │  │ scoring cluster   │  │  scoring cluster         │
└────────────────────────┘  └─────────────────────┘  └──────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│                       k3d-scoring                                  │
│                                                                    │
│  ┌────────────────────┐     ┌──────────┐                           │
│  │  leaderboard-api   │◄───▶│  Redis   │◀── shared by all clusters│
│  │  (Node/Express)    │     │          │                           │
│  └────────────────────┘     └──────────┘                           │
└────────────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. game-api (Python / FastAPI)

The game backend. Each gameplay cluster runs its own instance(s). Delegates all player/score operations to the leaderboard-api on the scoring cluster.

| Responsibility | Details |
|---|---|
| Piece generation | `GET /api/next-piece` — selects a random piece, applies scenario effects (mTLS corruption, auth denial, latency) |
| Player management | `POST /api/join` — proxies to leaderboard-api for registration |
| Scoring | `POST /api/score` — proxies to leaderboard-api for score updates |
| Leaderboard | `GET /api/leaderboard` — proxies to leaderboard-api |
| QR code | `GET /api/qr` — SVG QR code pointing to the dashboard's `/go` redirect |
| Admin controls | `POST /api/admin/*` — toggle health, latency, mTLS, auth policy, egress, weights, reset |
| Health | `GET /api/health` — returns 503 when the cluster is "killed" |
| Cluster identity | Writes its identity (name, color, region, external URL) to Redis on startup |

**Source:** `api/tetris-api/main.py`

### 2. game (Node / Express + React)

The player-facing UI. Serves the React game and proxies API calls to game-api through the mesh.

| Responsibility | Details |
|---|---|
| Static serving | Serves the React production build |
| API proxy | Proxies `/api/*` to `game-api-federated` via Linkerd |
| SPA fallback | All non-API routes serve `index.html` |

The proxy target `game-api-federated` is a Linkerd federated service that aggregates endpoints from all gameplay clusters, enabling cross-cluster load balancing transparently.

**Source:** `tetris/server/index.js` (server), `tetris/client/src/` (React app)

### 3. leaderboard-api (Node / Express)

The scoring microservice. Deployed only on the scoring cluster. Owns all player registration, score persistence, and leaderboard queries.

| Responsibility | Details |
|---|---|
| Player registration | `POST /api/join` — creates player in Redis, returns player_id |
| Score submission | `POST /api/score` — updates score based on lines cleared and level |
| Leaderboard | `GET /api/leaderboard` — top 20 players by score |
| Admin reset | `POST /api/admin/reset` — clears all player and game data |
| Health | `GET /api/health` — returns 200 when healthy |

The leaderboard-api is exported via Linkerd multicluster (`mirror.linkerd.io/exported: "true"`) so that game-api instances on gameplay clusters can reach it as `leaderboard-api-scoring.tetris.svc.cluster.local`.

**Source:** `api/leaderboard-api/`

### 4. agent (Node / Express)

The admin and aggregation backend. Deployed on gameplay and platform clusters for Kubernetes scaling operations; the platform cluster instance also serves cluster info, leaderboard, and the QR redirect.

| Responsibility | Details |
|---|---|
| Cluster discovery | Scans Redis for `*:game:cluster` keys to find all registered clusters |
| Cluster info | `GET /api/clusters`, `GET /api/info-all` — aggregated state from Redis |
| QR code | `GET /api/qr` — SVG QR code pointing to `/go` |
| Player redirect | `GET /go` — round-robin redirect distributing QR scanners across cluster frontends |
| Admin controls | `POST /api/admin/*` — writes scenario toggles to Redis for any cluster |
| Kubernetes scaling | `POST /admin/scale-down`, `/admin/scale-up` — patches Deployment replicas via the k8s API |
| Remote scaling | Proxies scale requests to other clusters via Linkerd-mirrored `agent-{cluster}` services |
| Leaderboard proxy | Fetches leaderboard from leaderboard-api on the scoring cluster |
| Event log | Maintains a per-cluster capped event log in Redis |

**Source:** `api/agent/index.js`

### 5. dashboard (Node / Express + React)

The presenter-facing UI. Shows real-time traffic visualization, cluster cards, leaderboard, and the QR code.

| Responsibility | Details |
|---|---|
| Static serving | Serves the React dashboard build |
| Proxy: `/go` | Proxied to agent (round-robin player redirect) |
| Proxy: `/admin/*` | Proxied to agent (Kubernetes scaling) |
| Proxy: `/api/*` | Proxied to agent (cluster info, admin commands) |
| SPA fallback | All other routes serve `index.html` |

**Source:** `dashboard/server/index.js` (server), `dashboard/client/src/` (React app)

### 6. Redis

Shared state store deployed on the scoring cluster. All clusters connect to the same instance via a LoadBalancer IP.

---

## Request Flows

### Player Join Flow

```
Player scans QR code
        │
        ▼
  GET /go  (dashboard)
        │
        ▼
  agent round-robin redirect
        │  (Redis atomic counter → pick cluster)
        ▼
  302 → {cluster_external_url}/play
        │
        ▼
  game serves React app
        │
        ▼
  Player enters name → POST /api/join
        │  (proxied through game to game-api)
        ▼
  game-api proxies to leaderboard-api (scoring cluster)
        │
        ▼
  leaderboard-api creates player in Redis
        │
        ▼
  Returns player_id, cluster identity
```

### Piece Request Flow (the core mesh call)

```
Player board needs next piece
        │
        ▼
  GET /api/next-piece?player_id=...
        │
  game proxy
        │
        ▼
  game-api-federated  (Linkerd federated service)
        │
   Linkerd sidecar load-balances across all gameplay clusters
        │
   ┌────┴────┬──────────────────┐
   │         │                  │
 east      west             central
   │         │                  │
   └────┬────┴──────────────────┘
        │
  Scenario effects applied:
  - Latency injection (sleep)
  - mTLS corruption (piece swap)
  - Auth policy denial (403)
  - Health check (503 if killed)
        │
        ▼
  Response: { piece_type, cluster, cluster_color, latency_ms, ... }
        │
        ▼
  Player board renders piece with cluster badge
```

### Score Submission Flow (cross-cluster dependency)

```
Player clears lines
        │
        ▼
  POST /api/score  { player_id, lines_cleared, level }
        │
  game proxy → game-api
        │
        ▼
  game-api proxies to leaderboard-api
  (leaderboard-api-scoring.tetris.svc.cluster.local)
        │
   Linkerd multicluster service → scoring cluster
        │
        ▼
  leaderboard-api updates score in Redis
        │
        ▼
  Returns updated score/level
```

### QR Code Redirect Flow (round-robin)

When multiple users scan the same QR code, they are distributed across different gameplay cluster frontends:

```
QR code → GET {DASHBOARD_URL}/go
               │
               ▼
         agent
               │
     ┌─────────┴───────────┐
     │  Redis INCR         │
     │  global:redirect:   │
     │  counter            │
     └─────────┬───────────┘
               │
     counter mod len(clusters) → index
               │
     Sort clusters alphabetically for deterministic order
               │
     Read cluster's external_url from Redis
               │
               ▼
     302 Redirect → {cluster_external_url}/play

  User 1 → gameplay-east/play
  User 2 → gameplay-west/play
  User 3 → gameplay-central/play
  User 4 → gameplay-east/play  (wraps around)
```

### Admin Action Flow

```
Presenter clicks control on dashboard
        │
        ▼
  dashboard
        │
  POST /api/admin/{action}  (proxied to agent)
        │
        ▼
  agent writes to Redis
  (targets specific cluster by key prefix)
        │
        ▼
  game-api reads updated state on next request
  (effects applied immediately)
```

### Kubernetes Scaling Flow

```
Presenter clicks "Kill" on cluster card
        │
        ▼
  POST /admin/scale-down  { cluster: "gameplay-west" }
        │
  agent on platform cluster
        │
   Is target == self?
   ├─ Yes → PATCH k8s Deployment replicas=0
   └─ No  → Proxy to agent-{cluster}
            via Linkerd service mirroring
            │
            ▼
            Remote agent patches its own Deployment
        │
        ▼
  Set Redis {cluster}:game:state:healthy = "0"
  Push event to {cluster}:event:log
```

---

## Redis Data Model

All clusters share a single Redis instance on the scoring cluster. Keys are prefixed to namespace data by cluster or as global.

### Key Naming Conventions

| Prefix | Scope | Example |
|---|---|---|
| `{cluster}:` | Per-cluster state | `gameplay-east:game:state` |
| `global:` | Shared across all clusters | `global:player:p_abc12345` |

### Per-Cluster Keys

#### `{cluster}:game:state` (Hash)

Core game/scenario state for a cluster. Read on every piece request.

| Field | Type | Default | Description |
|---|---|---|---|
| `active_scenario` | string | `"httproute"` | Currently active demo module (`httproute`, `latency`, `mtls`, `auth-policy`, `resiliency`, `egress`) |
| `mtls_enabled` | `"0"` / `"1"` | `"1"` | Whether mTLS is active; when `"0"`, pieces may be corrupted in transit |
| `interceptor_active` | `"0"` / `"1"` | `"0"` | Set to `"1"` when a corruption event occurs (for dashboard indicator) |
| `intercepted_count` | int string | `"0"` | Running count of tampered pieces |
| `auth_policy_enabled` | `"0"` / `"1"` | `"0"` | Whether the AuthorizationPolicy denial simulation is active |
| `auth_deny_rate` | float string | `"0.35"` | Probability of denying a request when auth policy is enabled |
| `egress_enabled` | `"0"` / `"1"` | `"0"` | Whether egress bonus pieces are active (25% chance of forced "I" piece) |
| `artificial_latency_ms` | int string | `"0"` | Milliseconds of sleep injected before each piece response |
| `healthy` | `"0"` / `"1"` | `"1"` | Cluster health flag; `"0"` causes `/api/health` and `/api/next-piece` to return 503 |
| `failure_enabled` | `"0"` / `"1"` | `"0"` | Whether 503 failure injection is active; when `"1"`, all `/api/next-piece` requests return 503 |
| `access_policy` | string | `"allow"` | Current access policy mode (used by dashboard to display policy state) |
| `traffic_weights` | JSON string | `"{}"` | Informational traffic weight map (actual routing is handled by Linkerd) |

#### `{cluster}:game:stats` (Hash)

Aggregate counters for a cluster.

| Field | Type | Default | Description |
|---|---|---|---|
| `total_pieces_served` | int string | `"0"` | Total pieces generated by this cluster |
| `total_requests` | int string | `"0"` | Total `/api/next-piece` requests received |

#### `{cluster}:game:piece_counts` (Hash)

Per-piece-type counters. Keys are piece type letters, values are counts.

| Field | Type | Description |
|---|---|---|
| `I` | int string | Count of I-pieces served |
| `O` | int string | Count of O-pieces served |
| `T` | int string | Count of T-pieces served |
| `S` | int string | Count of S-pieces served |
| `Z` | int string | Count of Z-pieces served |
| `J` | int string | Count of J-pieces served |
| `L` | int string | Count of L-pieces served |

#### `{cluster}:game:cluster` (Hash)

Cluster identity, written by game-api on startup. Used by agent for cluster discovery and info display.

| Field | Type | Description |
|---|---|---|
| `name` | string | Cluster display name (e.g., `"gameplay-east"`) |
| `color` | string | Hex color (e.g., `"#3b82f6"`) |
| `region` | string | Region label (e.g., `"gameplay-east"`) |
| `pod` | string | Hostname of the pod that last wrote this key |
| `external_url` | string | Public URL of this cluster's game frontend (e.g., `"http://gameplay-east.localhost:8080"`) |

#### `{cluster}:event:log` (List)

Capped event log (max 200 entries). Each entry is a JSON string.

```json
{
  "time": "2025-03-15T14:30:00.000Z",
  "cluster": "gameplay-east",
  "text": "Latency set to 800ms"
}
```

Managed by agent's `pushLog()` function. Entries are prepended (LPUSH) and the list is trimmed (LTRIM 0 199).

### Global Keys

#### `global:players` (Set)

Set of all player IDs (e.g., `"p_abc12345"`). Shared across all clusters so any cluster can look up any player.

#### `global:player:{player_id}` (Hash)

Per-player state. Created by leaderboard-api via `/api/join`, updated by leaderboard-api via `/api/score`.

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | — | Player display name (max 20 chars) |
| `score` | int string | `"0"` | Cumulative score |
| `lines` | int string | `"0"` | Total lines cleared |
| `level` | int string | `"1"` | Current level |
| `pieces` | int string | `"0"` | Total pieces received |
| `clusters_served` | string | `""` | Comma-separated list of cluster names that have served this player |
| `active` | `"0"` / `"1"` | `"1"` | Whether the player is active |
| `joined_at` | float string | — | Unix timestamp of join time |
| `last_seen` | float string | — | Unix timestamp of last piece request (used for 60s activity window) |

#### `global:redirect:counter` (String / Integer)

Atomic counter used by the `/go` endpoint for round-robin distribution of QR code scanners across clusters. Incremented with `INCR` on each redirect request.

### Cluster Discovery

The agent discovers clusters dynamically by scanning Redis keys:

```javascript
const keys = await redis.keys('*:game:cluster');
// keys = ["gameplay-east:game:cluster", "gameplay-west:game:cluster", "gameplay-central:game:cluster"]
// cluster names extracted by stripping ":game:cluster" suffix
```

This means clusters self-register by writing their identity to `{cluster}:game:cluster` on startup. No static configuration of the cluster list is needed.

---

## Kubernetes Resources

### Deployments

| Deployment | Image | Clusters | Scalable | Purpose |
|---|---|---|---|---|
| `game` | `game` | Gameplay (3) | Yes | Serves React game + proxies to game-api |
| `game-api` | `game-api` | Gameplay (3) | Yes (0 for failover demo) | FastAPI game backend |
| `leaderboard-api` | `leaderboard-api` | Scoring (1) | Yes | Scoring microservice |
| `dashboard` | `dashboard` | Platform (1) | Yes | Serves React dashboard + proxies to agent |
| `agent` | `agent` | Gameplay (3) + Platform (1) | No (always 1) | Admin API, k8s scaling, cluster info aggregation |

### Services

| Service | Type | Labels | Purpose |
|---|---|---|---|
| `game` | LoadBalancer | — | Player entry point |
| `game-api` | ClusterIP | `mirror.linkerd.io/federated: member` | Federated across gameplay clusters via Linkerd |
| `leaderboard-api` | ClusterIP | `mirror.linkerd.io/exported: "true"` | Exported for cross-cluster access from gameplay clusters |
| `dashboard` | LoadBalancer (port 8090) | — | Presenter entry point |
| `agent` | ClusterIP | `mirror.linkerd.io/exported: "true"` | Mirrored for cross-cluster scaling proxy |
| `redis` | LoadBalancer | — | Shared state store on scoring cluster |

### Linkerd Multicluster Labels

| Label | Effect |
|---|---|
| `mirror.linkerd.io/federated: member` | Linkerd aggregates endpoints from this service across all linked clusters into a single `{name}-federated` service |
| `mirror.linkerd.io/exported: "true"` | Linkerd mirrors this service to linked clusters as `{name}-{cluster}` |

### How Federated vs. Exported Services Differ

- **Federated (`game-api`):** All gameplay cluster endpoints are merged into one virtual service (`game-api-federated`). Linkerd load-balances across all clusters transparently. The client resolves a single DNS name.
- **Exported (`agent`, `leaderboard-api`, `redis`):** Each cluster's service appears as a distinct mirrored service in the target cluster (e.g., `agent-gameplay-central`, `leaderboard-api-scoring`). The client must explicitly choose which cluster to call.

---

## Environment Variables

### game-api

| Variable | Description | Default |
|---|---|---|
| `CLUSTER_NAME` | Cluster identity for piece badges and Redis key prefix | `local-dev` |
| `CLUSTER_COLOR` | Hex color for UI differentiation | `#3b82f6` |
| `CLUSTER_REGION` | Region label shown in the UI | `localhost` |
| `EXTERNAL_URL` | Public URL of this cluster's game frontend | `http://localhost:8000` |
| `ADMIN_TOKEN` | Token required for all `/api/admin/*` calls | `demo-admin-2024` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `LEADERBOARD_API_URL` | URL of the leaderboard-api service (cross-cluster) | _(required)_ |

### leaderboard-api

| Variable | Description | Default |
|---|---|---|
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `ADMIN_TOKEN` | Token required for admin endpoints | `demo-admin-2024` |

### agent

| Variable | Description | Default |
|---|---|---|
| `CLUSTER_NAME` | This cluster's identity | `local-dev` |
| `DASHBOARD_URL` | Public URL of the dashboard (used for QR code and `/go` redirect) | `http://localhost:8001` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `ADMIN_TOKEN` | Token required for admin write endpoints | `demo-admin-2024` |
| `DEPLOYMENT_NAME` | Name of the game-api Deployment (for k8s scaling) | `game-api` |
| `SERVICE_PORT` | Port number for the game-api Service (used in k8s Service patches) | `80` |
| `HTTPROUTE_NAME` | Name of the HTTPRoute resource (used for mode switching) | `game-api` |
| `LEADERBOARD_API_URL` | URL of the leaderboard-api service (cross-cluster) | _(optional)_ |

### game

| Variable | Description | Default |
|---|---|---|
| `API_TARGET` | URL of the game-api (federated service in k8s) | `http://127.0.0.1:8000` |

### dashboard

| Variable | Description | Default |
|---|---|---|
| `AGENT_TARGET` | URL of the agent | `http://127.0.0.1:8001` |

---

## Helm Chart

The Helm chart at `helm/tetris/` deploys all components. Each cluster enables only the services it needs.

### Key Values

| Value | Description | Default |
|---|---|---|
| `cluster.name` | Cluster identity | `"gameplay-east"` |
| `cluster.color` | Hex color for piece badges | `"#3b82f6"` |
| `cluster.region` | Region label | `"US East"` |
| `externalUrl` | Public URL for the game frontend (used in QR redirect targets) | `"https://rush.your-domain.com"` |
| `adminToken` | Token for presenter controls | `"demo-admin-2024"` |
| `game.enabled` | Deploy game frontend | `true` |
| `gameApi.enabled` | Deploy game-api backend | `true` |
| `dashboard.enabled` | Deploy dashboard frontend | `false` |
| `agent.enabled` | Deploy agent | `true` |
| `leaderboardApi.enabled` | Deploy leaderboard-api | `false` |
| `leaderboardApiUrl` | Cross-cluster URL for leaderboard-api | `""` |
| `redis.deploy` | Whether to deploy a Redis instance on this cluster | `false` |
| `redis.url` | Redis connection URL (point to the scoring cluster's Redis) | `""` |
| `service.mode` | Initial multicluster mode (`federated`, `mirrored`, `gateway`) | `federated` |
| `linkerd.injectNamespace` | Enable Linkerd injection at namespace level | `true` |
| `linkerd.injectPods` | Add `linkerd.io/inject: enabled` annotation to pods | `true` |

### Per-Cluster Overrides

Each cluster is deployed with `--set` overrides from `scripts/k3d.sh`:

| Cluster | Enabled Services | Special Config |
|---|---|---|
| `scoring` | leaderboard-api, Redis | `redis.deploy=true` |
| `gameplay-east` | game, game-api, agent | `leaderboardApiUrl=http://leaderboard-api-scoring...` |
| `gameplay-west` | game, game-api, agent | `leaderboardApiUrl=http://leaderboard-api-scoring...` |
| `gameplay-central` | game, game-api, agent | `leaderboardApiUrl=http://leaderboard-api-scoring...` |
| `platform` | dashboard, agent | — |

The scoring cluster deploys first to establish Redis and the leaderboard-api. Gameplay clusters are deployed next with a cross-cluster reference to the leaderboard-api. The platform cluster deploys last.

---

## Scoring

| Lines Cleared | Base Points |
|---|---|
| 0 | 0 |
| 1 | 100 |
| 2 | 300 |
| 3 | 500 |
| 4 (Tetris) | 800 |

Final points = base points x current level. Submitted via `POST /api/score` through game-api to leaderboard-api.

---

## Piece Types

Standard Tetrominos: `I`, `O`, `T`, `S`, `Z`, `J`, `L`.

Scenario-specific behavior:
- **Egress enabled:** 25% chance of forced `I` piece, flagged as `egress: true`
- **mTLS disabled:** 80% chance of piece type being swapped to a random different type (`corrupted: true`)
- **Auth policy enabled:** 35% chance of `403 Forbidden` (no piece returned)
