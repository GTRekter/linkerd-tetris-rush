# Local Multicluster Deployment with k3d

Spin up three lightweight k3s clusters on your machine and deploy Tetris with full Linkerd multicluster — no cloud required.

The automated path is `./scripts/k3d-setup.sh`. This guide documents what that script does step by step, useful when you need to debug, modify individual steps, or understand what's happening under the hood.

## Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| [Docker](https://docs.docker.com/get-docker/) | k3d clusters run as containers | Required |
| [k3d](https://k3d.io/#installation) | Creates k3s clusters in Docker | `brew install k3d` |
| [kubectl](https://kubernetes.io/docs/tasks/tools/) | Cluster management | `brew install kubectl` |
| [helm](https://helm.sh/docs/intro/install/) | Deploy the application | `brew install helm` |
| [Linkerd CLI](https://linkerd.io/2/getting-started/) | Install and manage Linkerd | `curl --proto '=https' --tlsv1.2 -sSfL https://run.linkerd.io/install \| sh` |
| [step CLI](https://smallstep.com/docs/step-cli/installation/) | Generate trust anchor certs | `brew install step` |
| [jq](https://jqlang.github.io/jq/download/) | Parse node JSON for routing | `brew install jq` |

---

## Automated setup

Run the full setup in one command:

```bash
./scripts/k3d-setup.sh
```

Available subcommands:

```bash
./scripts/k3d-setup.sh          # full setup from scratch
./scripts/k3d-setup.sh deploy   # rebuild image + redeploy (clusters must exist)
./scripts/k3d-setup.sh teardown # delete all clusters, network, and certificates
```

The rest of this document walks through each step individually.

---

## 1. Create three k3d clusters on a shared network

All clusters must share a Docker network so their nodes can reach each other's pod IPs. Without this, Linkerd multicluster gateways cannot communicate.

```bash
docker network create multicluster-net

k3d cluster create us-east \
  --network multicluster-net \
  --api-port 6550 \
  -p "8080:80@loadbalancer" \
  --k3s-arg "--disable=traefik@server:0" \
  --k3s-arg "--cluster-cidr=10.10.0.0/16@server:0" \
  --k3s-arg "--service-cidr=10.110.0.0/16@server:0"

k3d cluster create eu-west \
  --network multicluster-net \
  --api-port 6551 \
  -p "8081:80@loadbalancer" \
  --k3s-arg "--disable=traefik@server:0" \
  --k3s-arg "--cluster-cidr=10.20.0.0/16@server:0" \
  --k3s-arg "--service-cidr=10.120.0.0/16@server:0"

k3d cluster create ap-south \
  --network multicluster-net \
  --api-port 6552 \
  -p "8082:80@loadbalancer" \
  --k3s-arg "--disable=traefik@server:0" \
  --k3s-arg "--cluster-cidr=10.30.0.0/16@server:0" \
  --k3s-arg "--service-cidr=10.130.0.0/16@server:0"
```

Each cluster has a non-overlapping pod CIDR and service CIDR. Traefik is disabled — we use the k3d load balancer port for ingress.

Wait for CoreDNS to be ready on all clusters:

```bash
for CTX in k3d-us-east k3d-eu-west k3d-ap-south; do
  kubectl --context="$CTX" wait deployment/coredns \
    --for=condition=available --namespace=kube-system --timeout=3m
done
```

---

## 2. Set context aliases

```bash
export CTX_EAST=k3d-us-east
export CTX_WEST=k3d-eu-west
export CTX_SOUTH=k3d-ap-south
```

---

## 3. Add cross-cluster pod routes (flat network)

k3d nodes are Docker containers on the same network, but they don't automatically know how to reach pod CIDRs in other clusters. You need to add static routes on every node so inter-cluster pod traffic is routed correctly.

```bash
CONTEXTS=("$CTX_EAST" "$CTX_WEST" "$CTX_SOUTH")

declare -a ALL_NODES=()
for CTX in "${CONTEXTS[@]}"; do
  while IFS=$'\t' read -r name cidr ip; do
    ALL_NODES+=("$CTX|$name|$cidr|$ip")
  done < <(kubectl --context="$CTX" get node -o json | \
    jq -r '.items[] | .metadata.name + "\t" + .spec.podCIDR + "\t" + (.status.addresses[] | select(.type == "InternalIP") | .address)')
done

for src in "${ALL_NODES[@]}"; do
  IFS='|' read -r src_ctx src_name src_cidr src_ip <<< "$src"
  for dst in "${ALL_NODES[@]}"; do
    IFS='|' read -r dst_ctx dst_name dst_cidr dst_ip <<< "$dst"
    [ "$src_ctx" = "$dst_ctx" ] && continue
    docker exec "$src_name" ip route add "$dst_cidr" via "$dst_ip" 2>/dev/null || true
  done
done
```

Verify routes are in place:

```bash
docker exec k3d-us-east-server-0 ip route | grep "10.20\|10.30"
```

You should see entries like `10.20.0.0/24 via 172.18.0.X` pointing to eu-west and ap-south nodes.

---

## 4. Generate a shared trust anchor

All clusters must share the same root certificate for mTLS cross-cluster communication. Linkerd uses this trust anchor to verify identities across cluster boundaries.

```bash
mkdir -p certificates

step certificate create root.linkerd.cluster.local certificates/ca.crt certificates/ca.key \
  --profile root-ca --no-password --insecure --force

step certificate create identity.linkerd.cluster.local certificates/issuer.crt certificates/issuer.key \
  --ca certificates/ca.crt --ca-key certificates/ca.key \
  --profile intermediate-ca --not-after 8760h --no-password --insecure --force
```

> **Note:** The `certificates/` directory is in `.gitignore`. Never commit these files.

---

## 5. Install Linkerd on each cluster

Install the Gateway API CRDs first (required by Linkerd):

```bash
for CTX in "$CTX_EAST" "$CTX_WEST" "$CTX_SOUTH"; do
  kubectl --context="$CTX" apply --server-side -f \
    https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml
done
```

Install Linkerd CRDs and the control plane using the shared trust anchor:

```bash
for CTX in "$CTX_EAST" "$CTX_WEST" "$CTX_SOUTH"; do
  linkerd --context="$CTX" install --crds | kubectl --context="$CTX" apply -f -
  linkerd --context="$CTX" install \
    --identity-trust-anchors-file certificates/ca.crt \
    --identity-issuer-certificate-file certificates/issuer.crt \
    --identity-issuer-key-file certificates/issuer.key \
    | kubectl --context="$CTX" apply -f -
done

# Verify all control planes are healthy
for CTX in "$CTX_EAST" "$CTX_WEST" "$CTX_SOUTH"; do
  linkerd --context="$CTX" check
done
```

---

## 6. Install the multicluster extension

```bash
for CTX in "$CTX_EAST" "$CTX_WEST" "$CTX_SOUTH"; do
  linkerd --context="$CTX" multicluster install | kubectl --context="$CTX" apply -f -
done

for CTX in "$CTX_EAST" "$CTX_WEST" "$CTX_SOUTH"; do
  linkerd --context="$CTX" multicluster check
done
```

The multicluster extension installs the **Link** CRD and the **multicluster gateway** in each cluster. The gateway is the entry point for cross-cluster traffic — other clusters route through it to reach mirrored services.

---

## 7. Link the clusters into us-east

Linking generates credentials that allow the source cluster to mirror services from the target cluster. The link resource is applied to the cluster that will *receive* mirrored traffic (us-east), and it references the cluster that *exports* services (eu-west, ap-south).

```bash
linkerd --context="$CTX_WEST" multicluster link --cluster-name eu-west | \
  kubectl --context="$CTX_EAST" apply -f -

linkerd --context="$CTX_SOUTH" multicluster link --cluster-name ap-south | \
  kubectl --context="$CTX_EAST" apply -f -

# Verify gateways are reachable
linkerd --context="$CTX_EAST" multicluster gateways
```

After linking, us-east will automatically mirror any service in eu-west or ap-south that has the label `mirror.linkerd.io/exported: "true"`.

---

## 8. Build and import the container image

Use a specific local tag so Kubernetes does not attempt to pull from a remote registry:

```bash
docker build -t tetris:local -f tetris/Dockerfile .

k3d image import tetris:local -c us-east
k3d image import tetris:local -c eu-west
k3d image import tetris:local -c ap-south
```

---

## 9. Deploy with Helm

Deploy the application to each cluster using per-cluster values files. The primary cluster (us-east) gets Ingress and TrafficSplit; secondary clusters only run the application.

```bash
HELM_CHART=./helm/tetris

# us-east: primary cluster — Ingress + TrafficSplit enabled
helm --kube-context="$CTX_EAST" upgrade --install tetris "$HELM_CHART" \
  -f helm/values-us-east.yaml \
  --namespace tetris --create-namespace \
  --set image.repository=tetris \
  --set image.tag=local

# eu-west: secondary cluster — no Ingress, no TrafficSplit
helm --kube-context="$CTX_WEST" upgrade --install tetris "$HELM_CHART" \
  -f helm/values-eu-west.yaml \
  --namespace tetris --create-namespace \
  --set image.repository=tetris \
  --set image.tag=local

# ap-south: secondary cluster — no Ingress, no TrafficSplit
helm --kube-context="$CTX_SOUTH" upgrade --install tetris "$HELM_CHART" \
  -f helm/values-ap-south.yaml \
  --namespace tetris --create-namespace \
  --set image.repository=tetris \
  --set image.tag=local
```

Wait for rollouts:

```bash
for CTX in "$CTX_EAST" "$CTX_WEST" "$CTX_SOUTH"; do
  kubectl --context="$CTX" -n tetris rollout status deployment/tetris --timeout=120s
done
```

The service deployed on each cluster has the label `mirror.linkerd.io/exported: "true"`. Once Linkerd detects this on eu-west and ap-south, it automatically creates mirror services on us-east:

```
tetris              ClusterIP  (local — us-east)
tetris-eu-west      ClusterIP  (mirrored from eu-west)
tetris-ap-south     ClusterIP  (mirrored from ap-south)
```

The `TrafficSplit` resource (deployed only on us-east) routes piece requests across all three with weights 40/30/30.

---

## 10. Verify and access

```bash
# Check all three services are visible on the primary cluster
kubectl --context="$CTX_EAST" -n tetris get svc

# Check the TrafficSplit
kubectl --context="$CTX_EAST" -n tetris get trafficsplit

# Check Linkerd multicluster gateway status
linkerd --context="$CTX_EAST" multicluster gateways
```

For local access, port-forward instead of configuring a real domain:

```bash
kubectl --context="$CTX_EAST" -n tetris port-forward svc/tetris 8000:80
```

- Player: http://localhost:8000/play
- Dashboard: http://localhost:8000/dashboard

---

## Helm chart reference

The chart at `helm/tetris/` templated all Kubernetes resources. Key values:

| Value | Description |
|---|---|
| `cluster.name` | Cluster identity shown on piece badges |
| `cluster.color` | Hex color for UI differentiation |
| `cluster.region` | Region label |
| `image.repository` / `image.tag` | Container image |
| `adminToken` | Token for presenter admin controls |
| `externalUrl` | Public URL for the QR code |
| `ingress.enabled` | Deploy Ingress (primary cluster only) |
| `trafficSplit.enabled` | Deploy TrafficSplit (primary cluster only) |
| `trafficSplit.backends` | List of `{service, weight}` entries |
| `service.exported` | Adds `mirror.linkerd.io/exported: "true"` label |

---

## Troubleshooting

### Multicluster gateways not alive

`linkerd --context="$CTX_EAST" multicluster gateways` shows probe failures. The flat network routes are missing or incomplete. Re-run the route script from step 3.

### Mirror services not appearing on us-east

Check the link resources are applied and the gateway is healthy:

```bash
kubectl --context="$CTX_EAST" get links -A
linkerd --context="$CTX_EAST" multicluster gateways
```

Also verify the service in the secondary cluster has the export label:

```bash
kubectl --context="$CTX_WEST" -n tetris get svc tetris -o jsonpath='{.metadata.labels}'
```

### CoreDNS not resolving cross-cluster services

Restart CoreDNS after linking clusters:

```bash
for CTX in "$CTX_EAST" "$CTX_WEST" "$CTX_SOUTH"; do
  kubectl --context="$CTX" rollout restart deploy coredns -n kube-system
done
```

### Pods cannot reach each other across clusters

Check routes on a node:

```bash
docker exec k3d-us-east-server-0 ip route
```

Expected: entries like `10.20.0.0/24 via 172.18.0.X` and `10.30.0.0/24 via 172.18.0.Y`.

---

## Cleanup

```bash
./scripts/k3d-setup.sh teardown
```

Or manually:

```bash
k3d cluster delete us-east eu-west ap-south
docker network rm multicluster-net
rm -rf certificates
```
