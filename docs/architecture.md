# Architecture

This document describes the system architecture, component interactions, request flows, and Redis data model for the Tetris Rush multicluster demo.

---

## High-Level Overview

Tetris Rush is a four-component system deployed across multiple Kubernetes clusters, connected by Linkerd's multicluster service mesh. A shared Redis instance provides cross-cluster state synchronization.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Dashboard Cluster                            │
│                                                                     │
│  ┌────────────────────┐     ┌──────────────────┐                    │
│  │ dashboard-frontend │────▶│  agent   │                    │
│  │ (React + Express)  │     │  (Node/Express)  │                    │
│  └────────────────────┘     └────────┬─────────┘                    │
│         ▲ presenter                  │                              │
│         │ browser                    │ reads/writes                 │
│                                      ▼                              │
│                              ┌──────────┐                           │
│                              │  Redis   │◀── shared by all clusters │
│                              └──────────┘                           │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────┐  ┌────────────────────────────────┐
│        Cluster: ap-central       │  │       Cluster: ap-south        │
│                                  │  │                                │
│ ┌────────────────┐ ┌────────────┐│  │┌────────────────┐ ┌───────────┐│
│ │tetris-frontend ├▶│ tetris-api ││  ││tetris-frontend ├▶│tetris-api ││
│ │(React+Express) │ │ (FastAPI)  ││  ││(React+Express) │ │(FastAPI)  ││
│ └────────────────┘ └────────────┘│  │└────────────────┘ └───────────┘│
│        ▲ player phone            │  │                                │
│        │ via QR                  │  │                                │
│ ┌─────────────┐                  │  │ ┌─────────────┐                │
│ │agent│ (for k8s scale)  │  │ │agent│                │
│ └─────────────┘                  │  │ └─────────────┘                │
└──────────────────────────────────┘  └────────────────────────────────┘
```

---

## Components

### 1. tetris-api (Python / FastAPI)

The game backend. Each cluster runs its own instance(s).

| Responsibility | Details |
|---|---|
| Piece generation | `GET /api/next-piece` — selects a random piece, applies scenario effects (mTLS corruption, auth denial, latency) |
| Player management | `POST /api/join` — registers a player; tracks score, lines, level, clusters served |
| Scoring | `POST /api/score` — updates score based on lines cleared and level |
| Leaderboard | `GET /api/leaderboard` — top 20 players by score |
| QR code | `GET /api/qr` — SVG QR code pointing to the dashboard's `/go` redirect |
| Admin controls | `POST /api/admin/*` — toggle health, latency, mTLS, auth policy, egress, weights, reset |
| Health | `GET /api/health` — returns 503 when the cluster is "killed" |
| Cluster identity | Writes its identity (name, color, region, external URL) to Redis on startup |

**Source:** `api/tetris-api/main.py`

### 2. tetris-frontend (Node / Express + React)

The player-facing UI. Serves the React game and proxies API calls to tetris-api through the mesh.

| Responsibility | Details |
|---|---|
| Static serving | Serves the React production build |
| API proxy | Proxies `/api/*` to `tetris-api-federated` via Linkerd |
| SPA fallback | All non-API routes serve `index.html` |

The proxy target `tetris-api-federated` is a Linkerd federated service that aggregates endpoints from all clusters, enabling cross-cluster load balancing transparently.

**Source:** `tetris/server/index.js` (server), `tetris/client/src/` (React app)

### 3. agent (Node / Express)

The admin and aggregation backend. Deployed on every cluster for Kubernetes scaling operations; the dashboard cluster instance also serves cluster info, leaderboard, and the QR redirect.

| Responsibility | Details |
|---|---|
| Cluster discovery | Scans Redis for `*:game:cluster` keys to find all registered clusters |
| Cluster info | `GET /api/clusters`, `GET /api/info-all` — aggregated state from Redis |
| QR code | `GET /api/qr` — SVG QR code pointing to `/go` |
| Player redirect | `GET /go` — round-robin redirect distributing QR scanners across cluster frontends |
| Admin controls | `POST /api/admin/*` — writes scenario toggles to Redis for any cluster |
| Kubernetes scaling | `POST /admin/scale-down`, `/admin/scale-up` — patches Deployment replicas via the k8s API |
| Remote scaling | Proxies scale requests to other clusters via Linkerd-mirrored `agent-{cluster}` services |
| Event log | Maintains a per-cluster capped event log in Redis |

**Source:** `api/agent/index.js`

### 4. dashboard-frontend (Node / Express + React)

The presenter-facing UI. Shows real-time traffic visualization, cluster cards, leaderboard, and the QR code.

| Responsibility | Details |
|---|---|
| Static serving | Serves the React dashboard build |
| Proxy: `/go` | Proxied to agent (round-robin player redirect) |
| Proxy: `/admin/*` | Proxied to agent (Kubernetes scaling) |
| Proxy: `/api/*` | Proxied to agent (cluster info, admin commands) |
| SPA fallback | All other routes serve `index.html` |

**Source:** `dashboard/server/index.js` (server), `dashboard/client/src/` (React app)

---

## Request Flows

### Player Join Flow

```
Player scans QR code
        │
        ▼
  GET /go  (dashboard-frontend)
        │
        ▼
  agent round-robin redirect
        │  (Redis atomic counter → pick cluster)
        ▼
  302 → {cluster_external_url}/play
        │
        ▼
  tetris-frontend serves React app
        │
        ▼
  Player enters name → POST /api/join
        │  (proxied through tetris-frontend to tetris-api)
        ▼
  tetris-api creates player in Redis
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
  tetris-frontend proxy
        │
        ▼
  tetris-api-federated  (Linkerd federated service)
        │
   Linkerd sidecar load-balances across all clusters
        │
   ┌────┴────┬────────────┐
   │         │            │
 ap-east  ap-central  ap-south
   │         │            │
   └────┬────┴────────────┘
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

### QR Code Redirect Flow (round-robin)

When multiple users scan the same QR code, they are distributed across different cluster frontends:

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

  User 1 → ap-east/play
  User 2 → ap-central/play
  User 3 → ap-south/play
  User 4 → ap-east/play  (wraps around)
```

### Admin Action Flow

```
Presenter clicks control on dashboard
        │
        ▼
  dashboard-frontend
        │
  POST /api/admin/{action}  (proxied to agent)
        │
        ▼
  agent writes to Redis
  (targets specific cluster by key prefix)
        │
        ▼
  tetris-api reads updated state on next request
  (effects applied immediately)
```

### Kubernetes Scaling Flow

```
Presenter clicks "Kill" on cluster card
        │
        ▼
  POST /admin/scale-down  { cluster: "eu-west" }
        │
  agent on dashboard cluster
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

All clusters share a single Redis instance. Keys are prefixed to namespace data by cluster or as global.

### Key Naming Conventions

| Prefix | Scope | Example |
|---|---|---|
| `{cluster}:` | Per-cluster state | `us-east:game:state` |
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

Cluster identity, written by tetris-api on startup. Used by agent for cluster discovery and info display.

| Field | Type | Description |
|---|---|---|
| `name` | string | Cluster display name (e.g., `"ap-east"`) |
| `color` | string | Hex color (e.g., `"#3b82f6"`) |
| `region` | string | Region label (e.g., `"ap-east"`) |
| `pod` | string | Hostname of the pod that last wrote this key |
| `external_url` | string | Public URL of this cluster's tetris-frontend (e.g., `"http://ap-east.localhost:8080"`) |

#### `{cluster}:event:log` (List)

Capped event log (max 200 entries). Each entry is a JSON string.

```json
{
  "time": "2025-03-15T14:30:00.000Z",
  "cluster": "ap-east",
  "text": "Latency set to 800ms"
}
```

Managed by agent's `pushLog()` function. Entries are prepended (LPUSH) and the list is trimmed (LTRIM 0 199).

### Global Keys

#### `global:players` (Set)

Set of all player IDs (e.g., `"p_abc12345"`). Shared across all clusters so any cluster can look up any player.

#### `global:player:{player_id}` (Hash)

Per-player state. Created by `/api/join`, updated by `/api/next-piece` and `/api/score`.

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
// keys = ["ap-east:game:cluster", "ap-central:game:cluster", "ap-south:game:cluster"]
// cluster names extracted by stripping ":game:cluster" suffix
```

This means clusters self-register by writing their identity to `{cluster}:game:cluster` on startup. No static configuration of the cluster list is needed.

---

## Kubernetes Resources

### Deployments

| Deployment | Image | Clusters | Scalable | Purpose |
|---|---|---|---|---|
| `tetris-frontend` | `tetris` | All | Yes | Serves React game + proxies to tetris-api |
| `tetris-api` | `tetris-api` | All | Yes (0 for failover demo) | FastAPI game backend |
| `dashboard-frontend` | `dashboard` | Dashboard only | Yes | Serves React dashboard + proxies to agent |
| `agent` | `agent` | All | No (always 1) | Admin API, k8s scaling, cluster info aggregation |

### Services

| Service | Type | Labels | Purpose |
|---|---|---|---|
| `tetris-frontend` | LoadBalancer | — | Player entry point |
| `tetris-api` | ClusterIP | `mirror.linkerd.io/federated: member` | Federated across clusters via Linkerd |
| `dashboard-frontend` | LoadBalancer (port 8090) | — | Presenter entry point |
| `agent` | ClusterIP | `mirror.linkerd.io/exported: "true"` | Mirrored for cross-cluster scaling proxy |
| `redis` | ClusterIP | `mirror.linkerd.io/exported: "true"` | Shared state store |

### Linkerd Multicluster Labels

| Label | Effect |
|---|---|
| `mirror.linkerd.io/federated: member` | Linkerd aggregates endpoints from this service across all linked clusters into a single `{name}-federated` service |
| `mirror.linkerd.io/exported: "true"` | Linkerd mirrors this service to linked clusters as `{name}-{cluster}` |

### How Federated vs. Exported Services Differ

- **Federated (`tetris-api`):** All cluster endpoints are merged into one virtual service (`tetris-api-federated`). Linkerd load-balances across all clusters transparently. The client resolves a single DNS name.
- **Exported (`agent`, `redis`):** Each cluster's service appears as a distinct mirrored service in the target cluster (e.g., `agent-vastaya-ap-central`). The client must explicitly choose which cluster to call.

---

## Environment Variables

### tetris-api

| Variable | Description | Default |
|---|---|---|
| `CLUSTER_NAME` | Cluster identity for piece badges and Redis key prefix | `local-dev` |
| `CLUSTER_COLOR` | Hex color for UI differentiation | `#3b82f6` |
| `CLUSTER_REGION` | Region label shown in the UI | `localhost` |
| `EXTERNAL_URL` | Public URL of this cluster's tetris-frontend | `http://localhost:8000` |
| `ADMIN_TOKEN` | Token required for all `/api/admin/*` calls | `demo-admin-2024` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |

### agent

| Variable | Description | Default |
|---|---|---|
| `CLUSTER_NAME` | This cluster's identity | `local-dev` |
| `DASHBOARD_URL` | Public URL of the dashboard (used for QR code and `/go` redirect) | `http://localhost:8001` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `ADMIN_TOKEN` | Token required for admin write endpoints | `demo-admin-2024` |
| `DEPLOYMENT_NAME` | Name of the tetris-api Deployment (for k8s scaling) | `tetris-api` |
| `SERVICE_PORT` | Port number for the tetris-api Service (used in k8s Service patches) | `80` |
| `HTTPROUTE_NAME` | Name of the HTTPRoute resource (used for mode switching) | `tetris-api` |

### tetris-frontend

| Variable | Description | Default |
|---|---|---|
| `API_TARGET` | URL of the tetris-api (federated service in k8s) | `http://127.0.0.1:8000` |

### dashboard-frontend

| Variable | Description | Default |
|---|---|---|
| `AGENT_TARGET` | URL of the agent | `http://127.0.0.1:8001` |

---

## Helm Chart

The Helm chart at `helm/tetris/` deploys all four components plus Redis.

### Key Values

| Value | Description | Default |
|---|---|---|
| `cluster.name` | Cluster identity | `"us-east"` |
| `cluster.color` | Hex color for piece badges | `"#3b82f6"` |
| `cluster.region` | Region label | `"US East (N. Virginia)"` |
| `externalUrl` | Public URL for the tetris-frontend (used in QR redirect targets) | `"https://rush.your-domain.com"` |
| `dashboardUrl` | Public URL for the dashboard (used for QR code generation and `/go` redirect) | `""` |
| `adminToken` | Token for presenter controls | `"demo-admin-2024"` |
| `redis.deploy` | Whether to deploy a Redis instance on this cluster | `true` |
| `redis.url` | Override Redis URL (point to the dashboard cluster's Redis) | `""` |
| `dashboard.enabled` | Whether to deploy dashboard-frontend on this cluster | `true` |
| `service.federated` | Add `mirror.linkerd.io/federated: member` to tetris-api | `true` |
| `linkerd.injectNamespace` | Enable Linkerd injection at namespace level | `true` |
| `linkerd.injectPods` | Add `linkerd.io/inject: enabled` annotation to pods | `true` |

### Per-Cluster Overrides

Each cluster is deployed with `--set` overrides from `scripts/k3d.sh`. The script sets `cluster.name`, `cluster.color`, `cluster.region`, `externalUrl`, and `redis.url` (pointing to the dashboard cluster's Redis LoadBalancer IP). Only the first cluster (`ap-east`) sets `redis.deploy: true` and `dashboard.enabled: true`.

---

## Scoring

| Lines Cleared | Base Points |
|---|---|
| 0 | 0 |
| 1 | 100 |
| 2 | 300 |
| 3 | 500 |
| 4 (Tetris) | 800 |

Final points = base points x current level. Submitted via `POST /api/score` after each piece locks.

---

## Piece Types

Standard Tetrominos: `I`, `O`, `T`, `S`, `Z`, `J`, `L`.

Scenario-specific behavior:
- **Egress enabled:** 25% chance of forced `I` piece, flagged as `egress: true`
- **mTLS disabled:** 80% chance of piece type being swapped to a random different type (`corrupted: true`)
- **Auth policy enabled:** 35% chance of `403 Forbidden` (no piece returned)
