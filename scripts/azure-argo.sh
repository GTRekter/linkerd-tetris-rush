#!/bin/bash
set -euo pipefail

# ============================================================
# azure-argo.sh — Deploy Tetris Rush on AKS via Argo CD
#
# This script provisions 5 AKS clusters (3 gameplay + 1 scoring
# + 1 platform), sets up networking, installs Linkerd with
# multicluster, deploys Argo CD on the platform cluster, and
# lets Argo CD manage the full stack via the Application
# manifests in argo/.
# ============================================================

directory_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
directory_root="$(cd "$directory_script/.." && pwd)"

# ============================================================
# Configuration — override via environment variables
# ============================================================

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-cncfkl-dev}"
LOCATION="${LOCATION:-malaysiawest}"
ACR_NAME="${ACR_NAME:-acrcncfkl01}"
VNET_NAME="${VNET_NAME:-vnet-cncfkl}"
VNET_ADDRESS_PREFIX="${VNET_ADDRESS_PREFIX:-10.0.0.0/8}"
NODE_COUNT="${NODE_COUNT:-2}"
NODE_VM_SIZE="${NODE_VM_SIZE:-Standard_DS2_v2}"
# K8S_VERSION: set explicitly or leave empty to auto-detect the latest
# supported version in the target region.
K8S_VERSION="${K8S_VERSION:-1.34.3}"

application_namespace="tetris"

# 5 clusters: 3 gameplay + 1 scoring + 1 platform
cluster_names=(
    "gameplay-east"
    "gameplay-west"
    "gameplay-central"
    "scoring"
    "platform"
)

cluster_roles=(
    "gameplay"
    "gameplay"
    "gameplay"
    "scoring"
    "platform"
)

# Subnet CIDRs (one per cluster)
cluster_subnet_cidrs=(
    "10.10.0.0/16"
    "10.20.0.0/16"
    "10.30.0.0/16"
    "10.40.0.0/16"
    "10.50.0.0/16"
)

# Service CIDRs (must not overlap with VNet or each other)
cluster_service_cidrs=(
    "172.16.0.0/16"
    "172.17.0.0/16"
    "172.18.0.0/16"
    "172.19.0.0/16"
    "172.20.0.0/16"
)

cluster_dns_ips=(
    "172.16.0.10"
    "172.17.0.10"
    "172.18.0.10"
    "172.19.0.10"
    "172.20.0.10"
)

# Images
dashboard_image="dashboard"
agent_image="agent"
game_image="game"
game_api_image="game-api"
leaderboard_api_image="leaderboard-api"
image_tag="latest"

echo "============================================"
echo "  Tetris Rush - Azure AKS 5-Cluster Setup"
echo "  (Argo CD mode)"
echo "============================================"
echo ""

# ============================================================
# Check dependencies
# ============================================================

for cmd in az kubectl helm docker step; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: $cmd is not installed." >&2
        exit 1
    fi
done

if [ -z "${BUOYANT_LICENSE:-}" ]; then
    echo "Error: BUOYANT_LICENSE environment variable is not set." >&2
    exit 1
fi

# Verify Azure CLI login
if ! az account show &>/dev/null; then
    echo "Error: Not logged in to Azure. Run 'az login' first." >&2
    exit 1
fi

# ============================================================
# Resolve Kubernetes version
# ============================================================

k8s_version_args=()
if [ -n "$K8S_VERSION" ]; then
    echo "Using Kubernetes version: $K8S_VERSION"
    k8s_version_args=(--kubernetes-version "$K8S_VERSION")
else
    echo "No K8S_VERSION set — AKS will use the default version for $LOCATION"
fi

# ============================================================
# Resource Group
# ============================================================

echo "Creating resource group: $RESOURCE_GROUP in $LOCATION..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

# ============================================================
# Azure Container Registry
# ============================================================

if az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
    echo "Azure Container Registry already exists: $ACR_NAME"
else
    echo "Creating Azure Container Registry: $ACR_NAME..."
    az acr create \
        --resource-group "$RESOURCE_GROUP" \
        --name "$ACR_NAME" \
        --sku Standard \
        --output none
fi

acr_login_server=$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)
echo "ACR login server: $acr_login_server"

echo "Logging in to ACR..."
az acr login --name "$ACR_NAME"

# ============================================================
# Build and push container images
# ============================================================

echo "Building and pushing container images to ACR (linux/amd64)..."
docker build --platform linux/amd64 -t "${acr_login_server}/${dashboard_image}:${image_tag}"       -f "$directory_root/dashboard/Dockerfile"              "$directory_root"
docker build --platform linux/amd64 -t "${acr_login_server}/${agent_image}:${image_tag}"           -f "$directory_root/api/agent/Dockerfile"              "$directory_root"
docker build --platform linux/amd64 -t "${acr_login_server}/${game_image}:${image_tag}"            -f "$directory_root/tetris/Dockerfile"                 "$directory_root"
docker build --platform linux/amd64 -t "${acr_login_server}/${game_api_image}:${image_tag}"        -f "$directory_root/api/tetris-api/Dockerfile"         "$directory_root"
docker build --platform linux/amd64 -t "${acr_login_server}/${leaderboard_api_image}:${image_tag}" -f "$directory_root/api/leaderboard-api/Dockerfile"    "$directory_root"

docker push "${acr_login_server}/${dashboard_image}:${image_tag}"
docker push "${acr_login_server}/${agent_image}:${image_tag}"
docker push "${acr_login_server}/${game_image}:${image_tag}"
docker push "${acr_login_server}/${game_api_image}:${image_tag}"
docker push "${acr_login_server}/${leaderboard_api_image}:${image_tag}"

echo "All images pushed to ACR"

# ============================================================
# Virtual Network and Subnets
# ============================================================

if az network vnet show --resource-group "$RESOURCE_GROUP" --name "$VNET_NAME" &>/dev/null; then
    echo "Virtual network already exists: $VNET_NAME"
else
    echo "Creating virtual network: $VNET_NAME..."
    az network vnet create \
        --resource-group "$RESOURCE_GROUP" \
        --name "$VNET_NAME" \
        --address-prefix "$VNET_ADDRESS_PREFIX" \
        --output none
fi

for i in "${!cluster_names[@]}"; do
    name="${cluster_names[$i]}"
    cidr="${cluster_subnet_cidrs[$i]}"
    if az network vnet subnet show --resource-group "$RESOURCE_GROUP" --vnet-name "$VNET_NAME" --name "subnet-${name}" &>/dev/null; then
        echo "Subnet already exists: subnet-${name}"
    else
        echo "Creating subnet: subnet-${name} (${cidr})..."
        az network vnet subnet create \
            --resource-group "$RESOURCE_GROUP" \
            --vnet-name "$VNET_NAME" \
            --name "subnet-${name}" \
            --address-prefix "$cidr" \
            --output none
    fi
done

# ============================================================
# AKS Clusters
# ============================================================

echo "Creating AKS clusters..."
for i in "${!cluster_names[@]}"; do
    name="${cluster_names[$i]}"

    if az aks show --resource-group "$RESOURCE_GROUP" --name "$name" &>/dev/null; then
        echo "AKS cluster already exists: ${name}"
    else
        subnet_id=$(az network vnet subnet show \
            --resource-group "$RESOURCE_GROUP" \
            --vnet-name "$VNET_NAME" \
            --name "subnet-${name}" \
            --query id -o tsv)

        echo "Creating AKS cluster: ${name}..."
        az aks create \
            --resource-group "$RESOURCE_GROUP" \
            --name "$name" \
            --location "$LOCATION" \
            --node-count "$NODE_COUNT" \
            --node-vm-size "$NODE_VM_SIZE" \
            "${k8s_version_args[@]}" \
            --network-plugin azure \
            --vnet-subnet-id "$subnet_id" \
            --service-cidr "${cluster_service_cidrs[$i]}" \
            --dns-service-ip "${cluster_dns_ips[$i]}" \
            --attach-acr "$ACR_NAME" \
            --generate-ssh-keys \
            --output none

        echo "  Cluster created: $name"
    fi
done

# Ensure all clusters can pull from ACR (covers already-existing clusters).
# --attach-acr on az aks update requires the ACR resource ID.
echo "Ensuring ACR pull access for all clusters..."
acr_id=$(az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query id -o tsv)
for name in "${cluster_names[@]}"; do
    kubelet_identity=$(az aks show \
        --resource-group "$RESOURCE_GROUP" \
        --name "$name" \
        --query identityProfile.kubeletidentity.objectId -o tsv)
    if az role assignment list --assignee "$kubelet_identity" --scope "$acr_id" --role AcrPull --query "[0].id" -o tsv 2>/dev/null | grep -q .; then
        echo "  ACR pull already assigned: $name"
    else
        echo "  Assigning AcrPull role: $name..."
        az role assignment create \
            --assignee "$kubelet_identity" \
            --role AcrPull \
            --scope "$acr_id" \
            --output none
        echo "  ACR pull assigned: $name"
    fi
done

# ============================================================
# Get credentials for all clusters
# ============================================================

echo "Fetching kubeconfig credentials..."
declare -a cluster_contexts
for name in "${cluster_names[@]}"; do
    az aks get-credentials \
        --resource-group "$RESOURCE_GROUP" \
        --name "$name" \
        --overwrite-existing \
        --output none
    cluster_contexts+=("$name")
    echo "  Credentials fetched: $name"
done

echo "Waiting for clusters to be ready..."
for context in "${cluster_contexts[@]}"; do
    kubectl --context="$context" wait node --all --for=condition=Ready --timeout=5m
    echo "  Cluster ready: $context"
done

# ============================================================
# Linkerd identity certificates
# ============================================================

echo "Download Linkerd CLI..."
curl --proto '=https' --tlsv1.2 -sSfL https://enterprise.buoyant.io/install | sh
export PATH="$HOME/.linkerd2/bin:$PATH"

echo "Generating identity certificates..."
certificate_directory=$(mktemp -d)
step certificate create root.linkerd.cluster.local \
    "$certificate_directory/ca.crt" "$certificate_directory/ca.key" \
    --profile root-ca --no-password --insecure --force
step certificate create identity.linkerd.cluster.local \
    "$certificate_directory/issuer.crt" "$certificate_directory/issuer.key" \
    --ca "$certificate_directory/ca.crt" --ca-key "$certificate_directory/ca.key" \
    --profile intermediate-ca --not-after 8760h --no-password --insecure --force

# ============================================================
# Argo CD installation on platform cluster
# ============================================================

helm repo add argo https://argoproj.github.io/argo-helm
helm repo update argo
if helm status argocd --kube-context=platform --namespace argocd &>/dev/null; then
    echo "Argo CD already installed on the platform cluster"
else
    echo "Installing Argo CD on the platform cluster..."
    helm install argocd argo/argo-cd \
        --kube-context=platform \
        --namespace argocd \
        --create-namespace \
        --set server.service.type=LoadBalancer \
        --wait \
        --timeout 5m
fi

# ============================================================
# Register remote clusters with Argo CD
# ============================================================

echo "Registering remote clusters with Argo CD..."
remote_clusters=("gameplay-east" "gameplay-west" "gameplay-central" "scoring")
for remote in "${remote_clusters[@]}"; do
    remote_api_server=$(az aks show \
        --resource-group "$RESOURCE_GROUP" \
        --name "$remote" \
        --query fqdn -o tsv)

    kubectl --context="$remote" create serviceaccount argocd-manager -n kube-system 2>/dev/null || true
    kubectl --context="$remote" create clusterrolebinding argocd-manager \
        --clusterrole=cluster-admin --serviceaccount=kube-system:argocd-manager 2>/dev/null || true

    cat <<EOSECRET | kubectl --context="$remote" apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: argocd-manager-token
  namespace: kube-system
  annotations:
    kubernetes.io/service-account.name: argocd-manager
type: kubernetes.io/service-account-token
EOSECRET

    for _ in $(seq 1 30); do
        token=$(kubectl --context="$remote" -n kube-system get secret argocd-manager-token -o jsonpath='{.data.token}' 2>/dev/null || true)
        if [[ -n "$token" ]]; then break; fi
        sleep 1
    done
    token=$(echo "$token" | base64 -d)

    cat <<EOSECRET | kubectl --context=platform apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: cluster-${remote}
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
type: Opaque
stringData:
  name: "${remote}"
  server: "https://${remote_api_server}:443"
  config: |
    {
      "bearerToken": "${token}",
      "tlsClientConfig": {
        "insecure": true
      }
    }
EOSECRET
    echo "  Registered cluster: $remote (${remote_api_server})"
done

# ============================================================
# Apply Argo CD manifests
# ============================================================

echo "Generating Argo CD manifests with actual cluster server URLs..."
argo_temp=$(mktemp -d)
cp "$directory_root"/argo/*.yaml "$argo_temp/"

for remote in "${remote_clusters[@]}"; do
    remote_api_server=$(az aks show \
        --resource-group "$RESOURCE_GROUP" \
        --name "$remote" \
        --query fqdn -o tsv)
    sed -i.bak "s|https://${remote}:6443|https://${remote_api_server}:443|g" "$argo_temp"/*.yaml
done

platform_api_server=$(az aks show \
    --resource-group "$RESOURCE_GROUP" \
    --name "platform" \
    --query fqdn -o tsv)
sed -i.bak "s|https://platform:6443|https://kubernetes.default.svc|g" "$argo_temp"/*.yaml

# Inject certificate values and license into the Linkerd control-plane ApplicationSet
CERT_DIR="$certificate_directory" BUOYANT_LIC="$BUOYANT_LICENSE" perl -i -pe '
    BEGIN {
        sub slurp { local $/; open my $f, "<", $_[0] or die $!; <$f> }
        $dir = $ENV{CERT_DIR};
        $lic = $ENV{BUOYANT_LIC};
        $trust = slurp("$dir/ca.crt");
        $crt   = slurp("$dir/issuer.crt");
        $key   = slurp("$dir/issuer.key");
        for ($trust, $crt, $key) { chomp; s/\n/\\n/g; $_ = qq{"$_"} }
    }
    s/REPLACE_BUOYANT_LICENSE/$lic/g;
    s/REPLACE_TRUST_ANCHOR_PEM/$trust/g;
    s/REPLACE_ISSUER_CRT_PEM/$crt/g;
    s/REPLACE_ISSUER_KEY_PEM/$key/g;
' "$argo_temp/linkerd-control-plane.yaml"
rm -f "$argo_temp"/*.bak

# Override image repositories to point to ACR.
# The Argo CD Applications pull the Helm chart from Git where images default
# to local names (e.g. "agent:local"). We inject image overrides into each
# existing component block inside valuesObject.
ACR_SERVER="$acr_login_server" IMG_TAG="$image_tag" perl -i -pe '
    BEGIN {
        $acr = $ENV{ACR_SERVER};
        $tag = $ENV{IMG_TAG};
        @keys = qw(game gameApi agent dashboard leaderboardApi);
        %map = (
            game           => "game",
            gameApi        => "game-api",
            agent          => "agent",
            dashboard      => "dashboard",
            leaderboardApi => "leaderboard-api",
        );
    }
    # Reset at document boundaries so each Application gets overrides
    %seen = () if /^---/;
    for my $key (@keys) {
        if (/^(\s+)\Q$key\E:\s*$/ && !$seen{$key}) {
            my $pad = $1;
            $_ .= "${pad}  image:\n${pad}    repository: ${acr}/$map{$key}\n${pad}    tag: \"${tag}\"\n${pad}    pullPolicy: Always\n";
            $seen{$key} = 1;
            last;
        }
    }
' "$argo_temp/tetris.yaml"

echo "Applying Argo CD manifests..."
kubectl --context=platform apply -f "$argo_temp/"
rm -rf "$argo_temp"

# ============================================================
# Patch external URLs with real LoadBalancer IPs
# ============================================================

# The QR code is generated by the platform agent using DASHBOARD_URL.
# On Azure the dashboard gets a dynamic LoadBalancer IP that isn't known
# until after Argo CD syncs. Wait for it, then patch the agent.

gameplay_clusters=("gameplay-east" "gameplay-west" "gameplay-central")

echo -n "Waiting for Dashboard LoadBalancer IP..."
dash_ip=""
while true; do
    dash_ip=$(kubectl --context=platform -n "$application_namespace" get svc dashboard \
        -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
    if [[ -n "$dash_ip" ]]; then
        echo " $dash_ip"
        break
    fi
    echo -n "."
    sleep 5
done
dashboard_url="http://${dash_ip}:8090"

echo "Patching agent DASHBOARD_URL on platform to ${dashboard_url}..."
kubectl --context=platform -n "$application_namespace" set env deploy/agent \
    DASHBOARD_URL="${dashboard_url}"

# Also patch EXTERNAL_URL on each gameplay cluster's game-api so the /go
# redirect sends players to the correct game LoadBalancer IP.
for context in "${gameplay_clusters[@]}"; do
    echo -n "Waiting for game LoadBalancer IP on $context..."
    game_ip=""
    while true; do
        game_ip=$(kubectl --context="$context" -n "$application_namespace" get svc game \
            -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
        if [[ -n "$game_ip" ]]; then
            echo " $game_ip"
            break
        fi
        echo -n "."
        sleep 5
    done

    echo "  Patching game-api EXTERNAL_URL on $context to http://${game_ip}..."
    kubectl --context="$context" -n "$application_namespace" set env deploy/game-api \
        EXTERNAL_URL="http://${game_ip}"
done

# ============================================================
# Final Output
# ============================================================

argocd_lb_ip=""
echo -n "Waiting for Argo CD LoadBalancer IP..."
while true; do
    argocd_lb_ip=$(kubectl --context=platform -n argocd get svc argocd-server \
        -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
    if [[ -n "$argocd_lb_ip" ]]; then
        echo " $argocd_lb_ip"
        break
    fi
    echo -n "."
    sleep 5
done

echo ""
echo "  ======================================"
echo ""
echo "All AKS clusters deployed successfully!"
echo "Argo CD is managing the application stack."
echo ""
echo "Tetris (players):"
for context in "${gameplay_clusters[@]}"; do
    game_ip=$(kubectl --context="$context" -n "$application_namespace" get svc game \
        -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
    echo "  http://${game_ip}  ($context)"
done
echo ""
echo "Dashboard (presenter):"
echo "  http://${dash_ip}:8090"
echo ""
echo "Argo CD:"
echo "  https://${argocd_lb_ip}"
echo "  Username: admin"
echo -n "  Password: "
for _ in $(seq 1 30); do
    pw=$(kubectl --context=platform -n argocd get secret argocd-initial-admin-secret \
        -o jsonpath='{.data.password}' 2>/dev/null || true)
    if [[ -n "$pw" ]]; then
        echo "$pw" | base64 -d
        echo ""
        break
    fi
    sleep 2
done
echo ""
echo "Kubernetes Resources:"
for context in "${cluster_contexts[@]}"; do
    echo "  watch kubectl --context=${context} get pods,svc,httproutes,server -A"
done
echo ""
echo "Multicluster Links:"
echo "  Link resources are dynamic and must be generated after Linkerd"
echo "  multicluster gateways have LoadBalancer IPs. Wait for Argo CD to"
echo "  finish syncing, then run:"
echo ""
for src in "${cluster_contexts[@]}"; do
    src_api_server=$(az aks show \
        --resource-group "$RESOURCE_GROUP" \
        --name "$src" \
        --query fqdn -o tsv)
    for dst in "${cluster_contexts[@]}"; do
        [ "$src" = "$dst" ] && continue
        echo "  linkerd --context=$src multicluster link-gen --cluster-name $src --api-server-address https://${src_api_server}:443 | kubectl --context=$dst apply -f -"
    done
done
echo ""
echo "Cleanup:"
echo "  az group delete --name $RESOURCE_GROUP --yes --no-wait"
echo ""
echo "  ======================================"
