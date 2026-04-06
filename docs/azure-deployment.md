# Azure AKS Deployment

This guide walks through deploying the full Tetris Rush multi-cluster environment on Azure Kubernetes Service (AKS) using Argo CD for GitOps.

---

## Prerequisites

The following tools must be installed:

| Tool | Purpose | Install |
|------|---------|---------|
| [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) | Azure resource management | `brew install azure-cli` |
| [kubectl](https://kubernetes.io/docs/tasks/tools/) | Kubernetes CLI | `brew install kubectl` |
| [Docker](https://www.docker.com/get-started) | Container runtime | `brew install --cask docker` |
| [Helm](https://helm.sh/docs/intro/install/) | Kubernetes package manager | `brew install helm` |
| [step](https://smallstep.com/docs/step-cli/) | Certificate generation for Linkerd identity | `brew install step` |

You also need:

- **`BUOYANT_LICENSE`** environment variable set to your Linkerd Enterprise license key
- An active Azure subscription (`az login` completed)

---

## Quick Start

Run the full setup script:

```bash
export BUOYANT_LICENSE="your-license-key"
./scripts/azure-argo.sh
```

This single script performs all the steps described below. The rest of this document explains what each step does.

---

## Configuration

All settings can be overridden via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `RESOURCE_GROUP` | `rg-cncfkl-dev` | Azure resource group name |
| `LOCATION` | `malaysiawest` | Azure region |
| `ACR_NAME` | `acrcncfkl01` | Azure Container Registry name |
| `VNET_NAME` | `vnet-cncfkl` | Virtual network name |
| `VNET_ADDRESS_PREFIX` | `10.0.0.0/8` | VNet address space |
| `NODE_COUNT` | `2` | Nodes per cluster |
| `NODE_VM_SIZE` | `Standard_DS2_v2` | VM size for cluster nodes |
| `K8S_VERSION` | *(auto-detected)* | Kubernetes version (latest in region if unset) |

Example with custom values:

```bash
export BUOYANT_LICENSE="your-license-key"
RESOURCE_GROUP=my-rg LOCATION=eastus NODE_COUNT=3 ./scripts/azure-argo.sh
```

---

## What the Script Does

### 1. Create Azure Resources

The script creates:

- **Resource group** in the configured Azure region
- **Azure Container Registry (ACR)** for storing container images
- **Virtual network** with five subnets (one per cluster)

### 2. Build and Push Container Images

Five container images are built for `linux/amd64` and pushed to ACR:

| Image | Dockerfile | Deployed To |
|-------|-----------|-------------|
| `dashboard` | `dashboard/Dockerfile` | platform |
| `agent` | `api/agent/Dockerfile` | gameplay-\*, platform |
| `game` | `tetris/Dockerfile` | gameplay-\* |
| `game-api` | `api/tetris-api/Dockerfile` | gameplay-\* |
| `leaderboard-api` | `api/leaderboard-api/Dockerfile` | scoring |

Images are cross-compiled with `--platform linux/amd64` so they run on AKS nodes regardless of your local architecture (e.g. Apple Silicon).

### 3. Create AKS Clusters

Five AKS clusters are provisioned on the shared VNet, each in its own subnet:

| Cluster | Role | Subnet CIDR | Service CIDR |
|---------|------|-------------|--------------|
| `gameplay-east` | Gameplay | `10.10.0.0/16` | `172.16.0.0/16` |
| `gameplay-west` | Gameplay | `10.20.0.0/16` | `172.17.0.0/16` |
| `gameplay-central` | Gameplay | `10.30.0.0/16` | `172.18.0.0/16` |
| `scoring` | Scoring | `10.40.0.0/16` | `172.19.0.0/16` |
| `platform` | Operations | `10.50.0.0/16` | `172.20.0.0/16` |

All clusters use the Azure CNI network plugin. The `AcrPull` role is explicitly assigned to each cluster's kubelet identity to authorize image pulls from ACR — this runs on every execution so pre-existing clusters are also covered.

### 4. Install Linkerd

A shared trust anchor and issuer certificate are generated using `step`:

```
root.linkerd.cluster.local (root CA)
  └── identity.linkerd.cluster.local (intermediate CA, 8760h TTL)
```

All five clusters share the same root CA, enabling cross-cluster mTLS.

### 5. Install Argo CD

Argo CD is installed on the **platform** cluster via Helm with a LoadBalancer service. The four remote clusters are registered by:

1. Creating a `argocd-manager` ServiceAccount with `cluster-admin` in each remote cluster
2. Generating long-lived tokens for those ServiceAccounts
3. Storing them as Argo CD cluster Secrets on the platform cluster

### 6. Apply Argo CD Manifests

The Argo CD Application manifests from `argo/` are processed and applied:

- Placeholder server URLs are replaced with actual AKS API server FQDNs
- Linkerd identity certificates and the Buoyant license are injected
- ACR image overrides (`image.repository`, `image.tag`, `image.pullPolicy`) are injected into each Application's `valuesObject` so Argo CD passes them as Helm values instead of using the local defaults from Git
- Argo CD manages the full deployment via sync waves:
  - Wave 0: Gateway API CRDs (all clusters)
  - Wave 1: Linkerd CRDs (all clusters)
  - Wave 2: Linkerd control plane (all clusters)
  - Wave 3: Linkerd multicluster (all clusters)
  - Wave 4: Tetris applications (per-cluster values)

### 7. Patch External URLs

After Argo CD syncs and services receive LoadBalancer IPs, the script patches runtime environment variables that cannot be known ahead of time:

- **Dashboard QR code** — the platform agent generates the QR code using `DASHBOARD_URL`. The script waits for the dashboard LoadBalancer IP and patches the agent deployment with the real URL (e.g. `http://<DASH_IP>:8090`).
- **Player redirect** — each gameplay cluster's `game-api` uses `EXTERNAL_URL` for the `/go` redirect. The script waits for each game LoadBalancer IP and patches game-api accordingly.

These patches trigger a rolling restart of the affected pods.

---

## Idempotency

The script is safe to run multiple times. All resource creation steps check for existence first:

- ACR, VNet, subnets, and AKS clusters are skipped if they already exist
- ACR pull role assignment runs every time (idempotent)
- Argo CD Helm install is skipped if already deployed
- Images are rebuilt and pushed on every run
- External URL patches are re-applied on every run

---

## Post-Deployment: Multicluster Links

Multicluster Link resources are dynamic and cannot be committed to Git. After Argo CD finishes syncing and Linkerd gateways have LoadBalancer IPs, generate them with:

```bash
# Example: link gameplay-east into all other clusters
linkerd --context=gameplay-east multicluster link-gen \
    --cluster-name gameplay-east \
    --api-server-address https://<gameplay-east-fqdn>:443 \
    | kubectl --context=gameplay-west apply -f -
```

The script prints the full set of `link-gen` commands for all cluster pairs at the end of execution.

---

## Endpoints After Deployment

The script prints all endpoints at the end. You can also retrieve them manually:

```bash
# Game endpoints (one per gameplay cluster)
for ctx in gameplay-east gameplay-west gameplay-central; do
  IP=$(kubectl --context=$ctx -n tetris get svc game -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
  echo "$ctx → http://${IP}"
done

# Dashboard
DASH_IP=$(kubectl --context=platform -n tetris get svc dashboard -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "Dashboard → http://${DASH_IP}:8090"

# Argo CD
ARGO_IP=$(kubectl --context=platform -n argocd get svc argocd-server -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "Argo CD → https://${ARGO_IP}"
```

**Getting the Argo CD admin password:**

```bash
kubectl --context=platform -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d
```

---

## Verifying the Deployment

Check that all pods are running:

```bash
kubectl get pods,svc,httproute,server -n tetris --context gameplay-east
kubectl get pods,svc,httproute,server -n tetris --context gameplay-west
kubectl get pods,svc,httproute,server -n tetris --context gameplay-central
kubectl get pods,svc,httproute,server -n tetris --context scoring
kubectl get pods,svc,httproute,server -n tetris --context platform
```

Verify Linkerd multicluster links:

```bash
linkerd --context gameplay-east multicluster check
linkerd --context gameplay-east multicluster gateways
```

Verify Argo CD sync status:

```bash
kubectl --context=platform -n argocd get applications
```

---

## Troubleshooting

### AKS cluster creation fails

Ensure your subscription has enough quota for the requested VM size and node count in the target region. Check quotas with:

```bash
az vm list-usage --location malaysiawest -o table
```

### ACR image pull errors (401 Unauthorized)

Verify the kubelet identity has the `AcrPull` role:

```bash
az aks check-acr --name gameplay-east --resource-group rg-cncfkl-dev --acr acrcncfkl01.azurecr.io
```

If pulls fail, re-assign the role manually:

```bash
ACR_ID=$(az acr show --name acrcncfkl01 --resource-group rg-cncfkl-dev --query id -o tsv)
KUBELET_ID=$(az aks show --resource-group rg-cncfkl-dev --name gameplay-east --query identityProfile.kubeletidentity.objectId -o tsv)
az role assignment create --assignee "$KUBELET_ID" --role AcrPull --scope "$ACR_ID"
```

### Image platform mismatch ("no match for platform in manifest")

Images must be built for `linux/amd64` to run on AKS nodes. If you built on Apple Silicon (ARM), the images will fail to start. The script uses `docker build --platform linux/amd64` to handle this. Re-run the script to rebuild and push corrected images.

### Argo CD applications stuck in "Progressing"

Check application sync status and events:

```bash
kubectl --context=platform -n argocd describe application <app-name>
```

### Linkerd gateway has no external IP

Check the gateway service status:

```bash
kubectl --context=gameplay-east -n linkerd-multicluster get svc linkerd-gateway
```

If the IP is pending, verify that the AKS load balancer has available public IPs.

### QR code points to localhost

The QR code is generated by the platform agent using the `DASHBOARD_URL` environment variable. If it points to `localhost`, the post-deployment patch didn't run or the pod hasn't restarted. Fix manually:

```bash
DASH_IP=$(kubectl --context=platform -n tetris get svc dashboard -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
kubectl --context=platform -n tetris set env deploy/agent DASHBOARD_URL="http://${DASH_IP}:8090"
```

Similarly, if the `/go` redirect sends players to the wrong URL, patch each gameplay cluster's game-api:

```bash
for ctx in gameplay-east gameplay-west gameplay-central; do
  IP=$(kubectl --context=$ctx -n tetris get svc game -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
  kubectl --context=$ctx -n tetris set env deploy/game-api EXTERNAL_URL="http://${IP}"
done
```

---

## Tearing Down

Delete the entire resource group (removes all clusters, ACR, VNet, and associated resources):

```bash
az group delete --name rg-cncfkl-dev --yes --no-wait
```
