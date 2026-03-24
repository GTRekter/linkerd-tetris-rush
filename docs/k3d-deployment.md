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

Three clusters are created on a shared Docker network (`vastaya-network`):

| Cluster | API Port | HTTP Port | Dashboard Port |
|---------|----------|-----------|----------------|
| `vastaya-ap-east` | 6550 | 8080 | 9090 |
| `vastaya-ap-central` | 6551 | 8081 | 9091 |
| `vastaya-ap-south` | 6552 | 8082 | 9092 |

Each cluster uses a unique pod CIDR (`10.10.0.0/16`, `10.20.0.0/16`, `10.30.0.0/16`) and service CIDR (`10.110.0.0/16`, `10.111.0.0/16`, `10.112.0.0/16`) to avoid conflicts. Traefik is disabled since Linkerd handles ingress.

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

All three clusters share the same root CA, enabling cross-cluster mTLS without additional configuration.

For each cluster, the script installs:
1. Gateway API CRDs (v1.2.1)
2. Linkerd CRDs
3. Linkerd control plane with the shared identity certificates

### 4. Install Linkerd Multicluster

Each cluster gets the multicluster extension with:
- A gateway (for gateway-mode traffic routing)
- Service mirror controllers pointing to the other two clusters

The script then links all clusters bidirectionally using `linkerd multicluster link-gen`, which:
- Creates a service account and RBAC in the source cluster
- Generates a `Link` resource applied to the destination cluster
- Uses the gateway's LoadBalancer IP and the Docker-internal API server IP for connectivity

### 5. Build and Import Container Images

Four container images are built from the repo:

| Image | Dockerfile | Clusters |
|-------|-----------|----------|
| `dashboard:local` | `dashboard/Dockerfile` | ap-east only |
| `dashboard-api:local` | `api/dashboard-api/Dockerfile` | All |
| `tetris:local` | `tetris/Dockerfile` | All |
| `tetris-api:local` | `api/tetris-api/Dockerfile` | All |

Images are imported into the appropriate k3d clusters using `k3d image import`.

### 6. Deploy with Helm

The Helm chart at `helm/tetris/` is deployed to each cluster with per-cluster overrides:

**ap-east (dashboard cluster):**
- `dashboard.enabled=true` — deploys the presenter dashboard
- `redis.deploy=true` — deploys the shared Redis instance
- Color: `#3b82f6` (blue)

**ap-central and ap-south:**
- `dashboard.enabled=false` — no dashboard frontend
- `redis.deploy=false` — connects to ap-east's Redis via LoadBalancer IP
- Colors: `#8b5cf6` (purple) and `#06b6d4` (cyan)

---

## Endpoints After Deployment

| Endpoint | URL | Description |
|----------|-----|-------------|
| Player (ap-east) | `http://ap-east.localhost:8080` | Tetris game |
| Player (ap-central) | `http://ap-central.localhost:8081` | Tetris game |
| Player (ap-south) | `http://ap-south.localhost:8082` | Tetris game |
| Presenter Dashboard | `http://ap-east.localhost:9090` | Admin dashboard |

---

## Verifying the Deployment

Check that all pods are running:

```bash
kubectl get pods,svc,httproute,server -n vastaya --context k3d-vastaya-ap-east
kubectl get pods,svc,httproute,server -n vastaya --context k3d-vastaya-ap-central
kubectl get pods,svc,httproute,server -n vastaya --context k3d-vastaya-ap-south
```

Verify Linkerd multicluster links:

```bash
linkerd --context k3d-vastaya-ap-east multicluster check
linkerd --context k3d-vastaya-ap-east multicluster gateways
```

---

## Troubleshooting

### Clusters fail to create

If k3d cluster creation fails, ensure Docker is running and has enough resources allocated (at least 8GB RAM recommended for three clusters).

### Linkerd gateway has no external IP

The script waits for each gateway's LoadBalancer IP. If it hangs, check that the k3d load balancer is healthy:

```bash
docker ps | grep k3d
```

### Redis is unreachable from non-dashboard clusters

Verify the Redis LoadBalancer IP is accessible:

```bash
kubectl --context k3d-vastaya-ap-east -n vastaya get svc redis -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

Then test connectivity from another cluster:

```bash
kubectl --context k3d-vastaya-ap-central run redis-test --rm -it --image=redis:alpine -- redis-cli -h <REDIS_IP> ping
```

### Cross-cluster routing not working

Verify the node-level routes are in place:

```bash
docker exec k3d-vastaya-ap-east-server-0 ip route
```

You should see routes for the other clusters' pod CIDRs.

---

## Tearing Down

Delete all clusters:

```bash
k3d cluster delete vastaya-ap-east vastaya-ap-central vastaya-ap-south
```

Remove the shared Docker network:

```bash
docker network rm vastaya-network
```
