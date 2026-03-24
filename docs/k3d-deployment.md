# K3d Deployment

This guide walks through deploying the full Tetris Rush multi-cluster environment locally using k3d.

---

## Prerequisites

The following tools must be installed:

| Tool | Purpose | Install |
|------|---------|---------|
| [k3d](https://k3d.io/) | Lightweight Kubernetes clusters in Docker | `brew install k3d` |
| [kubectl](https://kubernetes.io/docs/tasks/tools/) | Kubernetes CLI | `brew install kubectl` |
| [Docker](https://www.docker.com/get-started) | Container runtime | `brew install --cask docker` |
| [Helm](https://helm.sh/docs/intro/install/) | Kubernetes package manager | `brew install helm` |
| [step](https://smallstep.com/docs/step-cli/) | Certificate generation for Linkerd identity | `brew install step` |
| [jq](https://jqlang.github.io/jq/) | JSON processing (used by the setup script) | `brew install jq` |

You also need:

- **`BUOYANT_LICENSE`** environment variable set to your Linkerd Enterprise license key

---

## Quick Start

Run the full setup script:

```bash
export BUOYANT_LICENSE="your-license-key"
./scripts/k3d.sh
```

This single script performs all the steps described below. The rest of this document explains what each step does.

---

## What the Script Does

### 1. Create K3d Clusters

Five clusters are created on a shared Docker network (`tetris-network`), organized by domain:

| Cluster | Role | API Port | Game Port | Dashboard Port | Color |
|---------|------|----------|-----------|----------------|-------|
| `gameplay-east` | Gameplay | 6550 | 8080 | — | Blue (#3b82f6) |
| `gameplay-west` | Gameplay | 6551 | 8081 | — | Purple (#8b5cf6) |
| `gameplay-central` | Gameplay | 6552 | 8082 | — | Cyan (#06b6d4) |
| `scoring` | Scoring | 6553 | — | — | Amber (#f59e0b) |
| `platform` | Operations | 6554 | — | 9090 | Emerald (#10b981) |

Each cluster uses a unique pod CIDR (`10.10.0.0/16` through `10.50.0.0/16`) and service CIDR (`10.110.0.0/16` through `10.114.0.0/16`) to avoid conflicts. Traefik is disabled since Linkerd handles ingress.

Any existing k3d clusters are deleted before creation.

### 2. Configure Cross-Cluster Networking

The script adds IP routes between all cluster nodes so pods in one cluster can reach pods in another. This simulates a flat network where all clusters can communicate directly — required for Linkerd's remote discovery (mirrored) mode.

CoreDNS is also patched to resolve `host.k3d.internal` correctly across clusters.

### 3. Install Linkerd

A shared trust anchor and issuer certificate are generated using `step`:

```
root.linkerd.cluster.local (root CA)
  └── identity.linkerd.cluster.local (intermediate CA, 8760h TTL)
```

All five clusters share the same root CA, enabling cross-cluster mTLS without additional configuration.

For each cluster, the script installs:
1. Gateway API CRDs (v1.2.1)
2. Linkerd CRDs
3. Linkerd control plane with the shared identity certificates

### 4. Install Linkerd Multicluster

Each cluster gets the multicluster extension with:
- A gateway (for gateway-mode traffic routing)
- Service mirror controllers pointing to the other four clusters

The script then links all clusters bidirectionally using `linkerd multicluster link-gen`, which:
- Creates a service account and RBAC in the source cluster
- Generates a `Link` resource applied to the destination cluster
- Uses the gateway's LoadBalancer IP and the Docker-internal API server IP for connectivity

### 5. Build and Import Container Images

Five container images are built from the repo:

| Image | Dockerfile | Imported To |
|-------|-----------|-------------|
| `dashboard:local` | `dashboard/Dockerfile` | platform |
| `agent:local` | `api/agent/Dockerfile` | gameplay-*, platform |
| `game:local` | `tetris/Dockerfile` | gameplay-* |
| `game-api:local` | `api/tetris-api/Dockerfile` | gameplay-* |
| `leaderboard-api:local` | `api/leaderboard-api/Dockerfile` | scoring |

Images are imported only into clusters that need them using `k3d image import`.

### 6. Deploy with Helm

The Helm chart at `helm/tetris/` is deployed to each cluster in three phases:

**Phase 1 — Scoring cluster (first):**
- `leaderboardApi.enabled=true` — deploys the leaderboard-api
- `redis.deploy=true` — deploys the shared Redis instance
- Waits for Redis LoadBalancer IP before proceeding

**Phase 2 — Gameplay clusters (3x):**
- `game.enabled=true`, `gameApi.enabled=true`, `agent.enabled=true`
- `leaderboardApiUrl` set to the scoring cluster's leaderboard-api via Linkerd multicluster DNS
- `redis.url` set to the scoring cluster's Redis LoadBalancer IP
- Colors: blue, purple, cyan

**Phase 3 — Platform cluster (last):**
- `dashboard.enabled=true`, `agent.enabled=true`
- `redis.url` set to the scoring cluster's Redis LoadBalancer IP

### Alternative: Argo CD Deployment

Instead of direct Helm installs, you can deploy the entire stack via Argo CD using a separate script:

```bash
export BUOYANT_LICENSE="your-license-key"
./scripts/k3d-argocd.sh
```

This script sets up the same 5-cluster infrastructure (clusters, networking, Linkerd identity certificates) but replaces the Helm deployment phases with Argo CD:

1. **Argo CD is installed** on the platform cluster (namespace `argocd`)
2. **Remote clusters are registered** — ServiceAccount tokens are generated for each cluster and stored as Argo CD cluster Secrets
3. **Linkerd identity certificates** are pre-applied to all clusters
4. **Argo CD manifests from `argo/`** are applied — the AppProject, ApplicationSets, and Applications handle the full deployment via sync waves:
   - Wave 0: Gateway API CRDs (all clusters)
   - Wave 1: Linkerd CRDs (all clusters)
   - Wave 2: Linkerd control plane (all clusters)
   - Wave 3: Linkerd multicluster (all clusters)
   - Wave 4: Tetris applications (per-cluster values)
5. **Direct Helm installs are skipped** — Argo CD manages everything

The Argo CD UI is exposed at `https://platform.localhost:9091`.

**Getting the Argo CD admin password:**

```bash
kubectl --context k3d-platform -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d
```

**Note:** Multicluster Link resources cannot be statically committed to Git (they contain dynamic gateway IPs). The `k3d.sh` script generates and applies these after cluster creation regardless of the deployment mode. See `argo/linkerd-multicluster-link.yaml` for the generation script.

---

## Endpoints After Deployment

| Endpoint | URL | Description |
|----------|-----|-------------|
| Player (gameplay-east) | `http://gameplay-east.localhost:8080` | Tetris game |
| Player (gameplay-west) | `http://gameplay-west.localhost:8081` | Tetris game |
| Player (gameplay-central) | `http://gameplay-central.localhost:8082` | Tetris game |
| Presenter Dashboard | `http://platform.localhost:9090` | Admin dashboard |
| Argo CD | `https://platform.localhost:9091` | GitOps UI (`--argocd` mode only) |

---

## Verifying the Deployment

Check that all pods are running:

```bash
kubectl get pods,svc,httproute,server -n tetris --context k3d-gameplay-east
kubectl get pods,svc,httproute,server -n tetris --context k3d-gameplay-west
kubectl get pods,svc,httproute,server -n tetris --context k3d-gameplay-central
kubectl get pods,svc,httproute,server -n tetris --context k3d-scoring
kubectl get pods,svc,httproute,server -n tetris --context k3d-platform
```

Verify Linkerd multicluster links:

```bash
linkerd --context k3d-gameplay-east multicluster check
linkerd --context k3d-gameplay-east multicluster gateways
```

Verify cross-cluster leaderboard-api access:

```bash
# From a gameplay cluster, check the mirrored service exists
kubectl --context k3d-gameplay-east -n tetris get svc leaderboard-api-scoring
```

---

## Troubleshooting

### Clusters fail to create

If k3d cluster creation fails, ensure Docker is running and has enough resources allocated (at least 12GB RAM recommended for five clusters).

### Linkerd gateway has no external IP

The script waits for each gateway's LoadBalancer IP. If it hangs, check that the k3d load balancer is healthy:

```bash
docker ps | grep k3d
```

### Redis is unreachable from non-scoring clusters

Verify the Redis LoadBalancer IP is accessible:

```bash
kubectl --context k3d-scoring -n tetris get svc redis -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

Then test connectivity from another cluster:

```bash
kubectl --context k3d-gameplay-east run redis-test --rm -it --image=redis:alpine -- redis-cli -h <REDIS_IP> ping
```

### Leaderboard-api is unreachable from gameplay clusters

Verify the mirrored service exists:

```bash
kubectl --context k3d-gameplay-east -n tetris get svc leaderboard-api-scoring
```

If missing, check that the Linkerd multicluster link to the scoring cluster is healthy:

```bash
linkerd --context k3d-gameplay-east multicluster check
```

### Cross-cluster routing not working

Verify the node-level routes are in place:

```bash
docker exec k3d-gameplay-east-server-0 ip route
```

You should see routes for the other clusters' pod CIDRs.

---

## Tearing Down

Delete all clusters:

```bash
k3d cluster delete gameplay-east gameplay-west gameplay-central scoring platform
```

Remove the shared Docker network:

```bash
docker network rm tetris-network
```
