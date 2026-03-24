# Linkerd Tetris Rush

A live demo platform for showcasing Linkerd's multi-cluster service mesh capabilities through an interactive Tetris game. Players join via QR code, play Tetris across a distributed cluster topology, and a presenter dashboard visualizes traffic flows, mesh scenarios, and cluster health in real time.

## Components

| Component | Language | Framework | Purpose |
|-----------|----------|-----------|---------|
| `tetris-api` | Python | FastAPI | Game backend: piece generation, scoring, leaderboard, Redis state |
| `tetris-frontend` | JavaScript | Express + React | Player UI: 10x20 game board, controls, piece preview |
| `dashboard-api` | JavaScript | Express | Admin API: Kubernetes scaling, cluster discovery, scenario toggles |
| `dashboard-frontend` | JavaScript | Express + React | Presenter UI: traffic visualization, cluster cards, leaderboard |
| Redis | - | - | Shared cross-cluster state: players, game stats, event logs |

All components are containerized with multi-stage Docker builds and deployed via a single Helm chart.

## Project Structure

```
linkerd-tetris-rush/
├── api/
│   ├── tetris-api/          # FastAPI backend (Python 3.12)
│   └── dashboard-api/       # Express admin API (Node.js)
├── tetris/
│   ├── server/              # Express proxy server
│   └── client/src/          # React game frontend
├── dashboard/
│   ├── server/              # Express proxy server
│   └── client/src/          # React dashboard frontend
├── helm/tetris/             # Helm chart for all components
├── scripts/
│   ├── k3d.sh               # Multi-cluster setup automation
│   └── local-dev.sh         # Local development helper
└── docs/                    # Architecture and deployment guides
```

## Cluster Architecture

The project supports multiple Linkerd multi-cluster topologies across three K3d clusters: `ap-south`, `ap-central`, and `ap-east`.

When users scan the Dashboard QR code, they are randomly routed (round-robin) to one of the three Tetris LoadBalancer services (one per cluster). The presenter dashboard in `ap-east` aggregates data from all clusters via Redis and mirrored services.

## Demo Scenarios

The following scenarios can be toggled per-cluster from the presenter dashboard:

### Disable mTLS

Can be enabled selectively on each cluster. When mTLS is disabled on a cluster:
- The `tetris-api` and `tetris-frontend` deployment specs in that cluster receive the `linkerd.io/inject: disabled` annotation, removing the Linkerd sidecar proxy.
- 80% of pieces served to players on that cluster appear corrupted (rendered in black), visually demonstrating the loss of encryption.
- All requests are routed locally within the cluster only — federated/mirrored services become unreachable since the workload is no longer part of the mesh.

### Deny All (Server Resource)

Can be enabled selectively on each cluster. 
When applied:
- A Linkerd `Server` resource is deployed targeting the `tetris-frontend` pods. As result only clients that have been explicitly authorized may access the `tetris-api`. 
- All unauthorized requests routed to the `tetris-api` on that cluster receive a 403 denial, which the game UI surfaces as a blocked-request indicator.
When disabled:
- A Linkerd `Server` resource targeting the `tetris-frontend` pods is deleted.
- All unauthorized requests routed to the `tetris-api` on that cluster start working as expected.

### Deny All with Authorization Policy

Can be enabled selectively on each cluster. From the dashboard, the presenter can select which clients to authorize (e.g., `linkerd-gateway`, `tetris-frontend`). 
When applied:
- A Linkerd `AuthorizationPolicy` and `MeshTLSAuthentication` resource are deployed.
- Only traffic matching the specified client identities is permitted; 35% of other requests are denied with a 403.
When disabled:
- A Linkerd `AuthorizationPolicy` and `MeshTLSAuthentication` resource are deleted.
- **Gateway:** The `linkerd-gateway` identity is the only relevant identity, where cross-cluster traffic is tunneled through the multicluster gateway.
- **Remote-Discovery/Federated:** Cross-cluster traffic goes directly pod-to-pod, the identity presented need to be `tetris-frontend`.

### Latency Injection

Can be enabled selectively on each cluster via a slider (0–3000ms). When enabled:
- The `tetris-api` injects artificial sleep per request, up to the configured milliseconds.
- Players see a `"Fetching piece..."` spinner and a latency badge on each piece showing the response time.
- **Gateway/Remote-Discovery:** The latency keeps affecting the endpoints as they are blindly routed there. `RandomAvailableSelection` has no awareness of latency — each backend gets picked with equal probability regardless of how slow it is.
- **Federated:** The selection of the endpoints is based on P2C + PeakEwma. If an endpoint is slow, PeakEwma records the higher RTT and P2C deprioritizes it, routing most requests to faster endpoints. Traffic is not completely cut off — P2C still occasionally picks the slower endpoint, but the majority shifts to healthy ones.

### Kill (No Endpoints)
When you click `Kill` or `Revive`, it scales the tetris-api deployment down to 0 or up to 1 replicas. The killed services referenced in the `HTTPRoute` will be processed by the proxy. Because they have no endpoints, it zeros out the weight for that backend and tries the next one.

### Failure Rate (Status Code 503)
It will return 503 to all requests to the `tetris-api`.

- **Gateway/Remote-Discovery:** `HTTPRoute` splits traffic across 3 backends with equal weight. RandomAvailableSelection randomly picks a backend. If it picks an endpoint of a service with failure injection enabled, it returns 503, then the `tetris-frontend` retries. Circuit-breaking one gateway IP takes out the entire cluster's traffic for that backend, as it applies to the gateway.
- **Federated:** All endpoints from all clusters are unioned into a single P2C balancer pool. If P2C picks an endpoint with failure injection enabled, it returns 503, then the `tetris-frontend` retries. Circuit-breaking is per-pod, so only the specific failing pods get ejected while healthy pods in the same cluster continue serving. By default, the proxy is not aware of 503 status codes in responses. However, failure accrual can be configured with:

```
kubectl annotate svc tetris-api-federated -n vastaya \
  balancer.linkerd.io/failure-accrual=consecutive \
  balancer.linkerd.io/failure-accrual-consecutive-max-failures="1" \
  balancer.linkerd.io/failure-accrual-consecutive-min-penalty="1m" \
  balancer.linkerd.io/failure-accrual-consecutive-max-penalty="1m" \
  balancer.linkerd.io/failure-accrual-consecutive-jitter-ratio="0.5" \
  --overwrite
```

or removed via:

```
kubectl annotate svc tetris-api-federated -n vastaya \
  balancer.linkerd.io/failure-accrual- \
  balancer.linkerd.io/failure-accrual-consecutive-max-failures- \
  balancer.linkerd.io/failure-accrual-consecutive-min-penalty- \
  balancer.linkerd.io/failure-accrual-consecutive-max-penalty- \
  balancer.linkerd.io/failure-accrual-consecutive-jitter-ratio-
```

**Note:**  Even with failure accrual enabled, occasional 503s will still reach the frontend. These are probe requests — after the penalty period expires, the breaker reopens and sends a test request to check if the endpoint has recovered. If it still fails, the 503 leaks to the client before the breaker trips again. Increasing min-penalty reduces their frequency but cannot eliminate them entirely. A retry policy would be needed to fully hide probe failures from the client.

## Multi-Cluster Topology Modes

The topology mode can be switched live from the dashboard using a dropdown.

### Federated to Mirrored

- Changes the `tetris-api` service annotation in all clusters from `mirror.linkerd.io/federated=member` to `mirror.linkerd.io/exported=remote-discovery`. 
- An `HTTPRoute` is deployed in each cluster with `parentRef: tetris-api` and backends splitting traffic equally (33%) across the local `tetris-api` and the remote mirrored services (`tetris-api-vastaya-ap-*`). 
- The `tetris-frontend` targets the `tetris-api` service directly instead of `tetris-api-federated`.

### Mirrored to Gateway

- Changes the `tetris-api` service annotation in all clusters from `mirror.linkerd.io/exported=remote-discovery` to `mirror.linkerd.io/exported=true`. 
- The existing `HTTPRoute` configuration remains unchanged — the `tetris-frontend` continues targeting the `tetris-api` service.

### Mirrored/Gateway to Federated

- Changes the `tetris-api` service annotation in all clusters from `mirror.linkerd.io/exported=remote-discovery` or `mirror.linkerd.io/exported=true` back to `mirror.linkerd.io/federated=member`. 
- The `HTTPRoute` resources are deleted, and the `tetris-frontend` change to targeting the `tetris-api-federated` service.

## Endpoints

After deployment, the following endpoints are available:

| Endpoint | URL | Description |
|----------|-----|-------------|
| Player (ap-east) | `http://ap-east.localhost:8080` | Tetris game |
| Player (ap-central) | `http://ap-central.localhost:8081` | Tetris game |
| Player (ap-south) | `http://ap-south.localhost:8082` | Tetris game |
| Presenter Dashboard | `http://ap-east.localhost:9090` | Admin dashboard |

## Debug

kubectl get pods,svc,httproute,server -n vastaya --context k3d-vastaya-ap-east 
kubectl get pods,svc,httproute,server -n vastaya --context k3d-vastaya-ap-central 
kubectl get pods,svc,httproute,server -n vastaya --context k3d-vastaya-ap-south 

## Setup

Refer to the detailed guides in `docs/`:
- [Architecture](docs/architecture.md) — System design, request flows, and Redis data model
- [K3d Deployment](docs/k3d-deployment.md) — Full k3d + Linkerd installation steps
- [Local Development](docs/local-development.md) — Setup and debugging
- [Demo Modules](docs/modules.md) — Detailed scenario descriptions

### Federated Mode

In federated mode, each cluster exposes a `tetris-api-federated` ClusterIP service that aggregates traffic across local `tetris-api` instances. The `dashboard-api` services in `ap-south` and `ap-central` connect to Redis in `ap-east` via a cross-cluster LoadBalancer. The dashboard frontend in `ap-east` reaches remote `dashboard-api` instances through mirrored services.


```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                             k3d-vastaya-ap-south                                │
│                                                                                 │
│  ┌─────────────────────────┐                                                    │
│  │  tetris-frontend        │                                                    │
│  │  ┌───────────────────┐  │                                                    │
│  │  │  linkerd-proxy    │  │◄──── Tetris (LoadBalancer)                         │
│  │  └───────────────────┘  │                                                    │
│  └─────────────────────────┘                                                    │
│                                                                                 │
│  ┌─────────────────────────┐        ┌─────────────────────────┐                 │
│  │  tetris-api             │        │  dashboard-api          │                 │
│  │  ┌───────────────────┐  │        │  ┌───────────────────┐  │                 │
│  │  │  linkerd-proxy    │  │        │  │  linkerd-proxy    │  │                 │
│  │  └───────────────────┘  │        │  └───────────────────┘  │                 │
│  └────────────┬────────────┘        └────────────┬────────────┘                 │
│               │                                  │                              │
│  ┌────────────▼────────────┐        ┌────────────▼────────────┐                 │
│  │  tetris-api (ClusterIP) │        │  dashboard-api          │                 │
│  └────────────┬────────────┘        │  (ClusterIP)            │◄── cross-cluster│
│  ┌────────────▼────────────┐        └─────────────────────────┘     from east   │
│  │  tetris-api-federated   │                     │                              │
│  │  (ClusterIP)            │                     ▼                              │
│  └─────────────────────────┘          Redis (LoadBalancer) ──► ap-east          │
│                                                                                 │
│               Kubernetes API ◄── dashboard-api                                  │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                            k3d-vastaya-ap-central                               │
│                                                                                 │
│  ┌─────────────────────────┐                                                    │
│  │  tetris-frontend        │                                                    │
│  │  ┌───────────────────┐  │                                                    │
│  │  │  linkerd-proxy    │  │◄──── Tetris (LoadBalancer)                         │
│  │  └───────────────────┘  │                                                    │
│  └─────────────────────────┘                                                    │
│                                                                                 │
│  ┌─────────────────────────┐        ┌─────────────────────────┐                 │
│  │  tetris-api             │        │  dashboard-api          │                 │
│  │  ┌───────────────────┐  │        │  ┌───────────────────┐  │                 │
│  │  │  linkerd-proxy    │  │        │  │  linkerd-proxy    │  │                 │
│  │  └───────────────────┘  │        │  └───────────────────┘  │                 │
│  └────────────┬────────────┘        └────────────┬────────────┘                 │
│               │                                  │                              │
│  ┌────────────▼────────────┐        ┌────────────▼────────────┐                 │
│  │  tetris-api (ClusterIP) │        │  dashboard-api          │                 │
│  └────────────┬────────────┘        │  (ClusterIP)            │◄── cross-cluster│
│  ┌────────────▼────────────┐        └─────────────────────────┘     from east   │
│  │  tetris-api-federated   │                     │                              │
│  │  (ClusterIP)            │                     ▼                              │
│  └─────────────────────────┘          Redis (LoadBalancer) ──► ap-east          │
│                                                                                 │
│               Kubernetes API ◄── dashboard-api                                  │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                             k3d-vastaya-ap-east                                 │
│                                                                                 │
│  ┌─────────────────────────┐        ┌─────────────────────────┐  ┌───────────┐  │
│  │  tetris-frontend        │        │  dashboard              │  │  Redis    │  │
│  │  ┌───────────────────┐  │        │  ┌───────────────────┐  │  │           │  │
│  │  │  linkerd-proxy    │  │        │  │  linkerd-proxy    │  │  └─────┬─────┘  │
│  │  └───────────────────┘  │        │  └───────────────────┘  │        │        │
│  └─────────────────────────┘        └────────────┬────────────┘        │        │
│           ▲                                      │                     │        │
│           │                         ┌────────────┼─────────────────────┘        │
│   Tetris (LoadBalancer)             │            │                              │
│                          ┌──────────▼─────────────────────────────┐             │
│                          │  dashboard-api-vastaya-ap-central      │             │
│                          │  (ClusterIP)                           │             │
│                          ├────────────────────────────────────────┤             │
│                          │  dashboard-api-vastaya-ap-south        │             │
│                          │  (ClusterIP)                           │             │
│                          └────────────────────────────────────────┘             │
│                                                                                 │
│  ┌─────────────────────────┐        ┌─────────────────────────┐                 │
│  │  tetris-api             │        │  dashboard-api          │                 │
│  │  ┌───────────────────┐  │        │  ┌───────────────────┐  │                 │
│  │  │  linkerd-proxy    │  │        │  │  linkerd-proxy    │  │                 │
│  │  └───────────────────┘  │        │  └───────────────────┘  │                 │
│  └────────────┬────────────┘        └────────────┬────────────┘                 │
│               │                                  │                              │
│  ┌────────────▼────────────┐        ┌────────────▼────────────┐                 │
│  │  tetris-api (ClusterIP) │        │  dashboard-api          │                 │
│  └────────────┬────────────┘        │  (ClusterIP)            │                 │
│  ┌────────────▼────────────┐        └─────────────────────────┘                 │
│  │  tetris-api-federated   │                                                    │
│  │  (ClusterIP)            │       Redis (LoadBalancer) ◄── ap-south, ap-central│
│  └─────────────────────────┘                                                    │
│                                                                                 │
│               Kubernetes API ◄── dashboard-api                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Mirrored / Gateway Mode

In mirrored/gateway mode, remote cluster services are mirrored locally as `tetris-api-vastaya-ap-{region}` ClusterIP services. An `HttpRoute` resource in each cluster controls traffic routing and splitting across local and mirrored `tetris-api` services. The dashboard and Redis topology remains the same as federated mode.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                             k3d-vastaya-ap-south                                │
│                                                                                 │
│  ┌─────────────────────────┐                                                    │
│  │  tetris-frontend        │                                                    │
│  │  ┌───────────────────┐  │                                                    │
│  │  │  linkerd-proxy    │  │◄──── Tetris (LoadBalancer)                         │
│  │  └───────────────────┘  │                                                    │
│  └─────────────────────────┘                                                    │
│                                                                                 │
│  ┌──────────────────┐                                                           │
│  │  HttpRoute       │──┬──► tetris-api (ClusterIP)                             │
│  └──────────────────┘  │                                                        │
│                        ├──► tetris-api-vastaya-ap-central (ClusterIP)           │
│                        └──► tetris-api-vastaya-ap-east (ClusterIP)              │
│                                                                                 │
│  ┌─────────────────────────┐        ┌─────────────────────────┐                 │
│  │  tetris-api             │        │  dashboard-api          │                 │
│  │  ┌───────────────────┐  │        │  ┌───────────────────┐  │                 │
│  │  │  linkerd-proxy    │  │        │  │  linkerd-proxy    │  │                 │
│  │  └───────────────────┘  │        │  └───────────────────┘  │                 │
│  └─────────────────────────┘        └────────────┬────────────┘                 │
│                                     ┌────────────▼────────────┐                 │
│                                     │  dashboard-api          │                 │
│                                     │  (ClusterIP)            │◄── cross-cluster│
│                                     └─────────────────────────┘     from east   │
│                                                  │                              │
│                                                  ▼                              │
│                                       Redis (LoadBalancer) ──► ap-east          │
│                                                                                 │
│               Kubernetes API ◄── dashboard-api                                  │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                            k3d-vastaya-ap-central                               │
│                                                                                 │
│  ┌─────────────────────────┐                                                    │
│  │  tetris-frontend        │                                                    │
│  │  ┌───────────────────┐  │                                                    │
│  │  │  linkerd-proxy    │  │◄──── Tetris (LoadBalancer)                         │
│  │  └───────────────────┘  │                                                    │
│  └─────────────────────────┘                                                    │
│                                                                                 │
│  ┌──────────────────┐                                                           │
│  │  HttpRoute       │──┬──► tetris-api (ClusterIP)                              │
│  └──────────────────┘  │                                                        │
│                        ├──► tetris-api-vastaya-ap-south (ClusterIP)             │
│                        └──► tetris-api-vastaya-ap-east (ClusterIP)              │
│                                                                                 │
│  ┌─────────────────────────┐        ┌─────────────────────────┐                 │
│  │  tetris-api             │        │  dashboard-api          │                 │
│  │  ┌───────────────────┐  │        │  ┌───────────────────┐  │                 │
│  │  │  linkerd-proxy    │  │        │  │  linkerd-proxy    │  │                 │
│  │  └───────────────────┘  │        │  └───────────────────┘  │                 │
│  └─────────────────────────┘        └────────────┬────────────┘                 │
│                                     ┌────────────▼────────────┐                 │
│                                     │  dashboard-api          │                 │
│                                     │  (ClusterIP)            │◄── cross-cluster│
│                                     └─────────────────────────┘     from east   │
│                                                  │                              │
│                                                  ▼                              │
│                                       Redis (LoadBalancer) ──► ap-east          │
│                                                                                 │
│               Kubernetes API ◄── dashboard-api                                  │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                             k3d-vastaya-ap-east                                 │
│                                                                                 │
│  ┌─────────────────────────┐        ┌─────────────────────────┐  ┌───────────┐  │
│  │  tetris-frontend        │        │  dashboard              │  │  Redis    │  │
│  │  ┌───────────────────┐  │        │  ┌───────────────────┐  │  │           │  │
│  │  │  linkerd-proxy    │  │        │  │  linkerd-proxy    │  │  └─────┬─────┘  │
│  │  └───────────────────┘  │        │  └───────────────────┘  │        │        │
│  └─────────────────────────┘        └────────────┬────────────┘        │        │
│           ▲                                      │                     │        │
│           │                         ┌────────────┼─────────────────────┘        │
│   Tetris (LoadBalancer)             │            │                              │
│                          ┌──────────▼─────────────────────────────┐             │
│                          │  dashboard-api-vastaya-ap-central      │             │
│                          │  (ClusterIP)                           │             │
│                          ├────────────────────────────────────────┤             │
│                          │  dashboard-api-vastaya-ap-south        │             │
│                          │  (ClusterIP)                           │             │
│                          └────────────────────────────────────────┘             │
│                                                                                 │
│  ┌──────────────────┐                                                           │
│  │  HttpRoute       │──┬──► tetris-api (ClusterIP)                              │
│  └──────────────────┘  │                                                        │
│                        ├──► tetris-api-vastaya-ap-central (ClusterIP)           │
│                        └──► tetris-api-vastaya-ap-south (ClusterIP)             │
│                                                                                 │
│  ┌─────────────────────────┐        ┌─────────────────────────┐                 │
│  │  tetris-api             │        │  dashboard-api          │                 │
│  │  ┌───────────────────┐  │        │  ┌───────────────────┐  │                 │
│  │  │  linkerd-proxy    │  │        │  │  linkerd-proxy    │  │                 │
│  │  └───────────────────┘  │        │  └───────────────────┘  │                 │
│  └─────────────────────────┘        └────────────┬────────────┘                 │
│                                     ┌────────────▼────────────┐                 │
│                                     │  dashboard-api          │                 │
│                                     │  (ClusterIP)            │                 │
│                                     └─────────────────────────┘                 │
│                                                                                 │
│                                    Redis (LoadBalancer) ◄── ap-south, ap-central│
│                                                                                 │
│               Kubernetes API ◄── dashboard-api                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```
