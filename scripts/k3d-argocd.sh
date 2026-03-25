#!/bin/bash
set -euo pipefail

# ============================================================
# k3d-argocd.sh — Deploy Tetris Rush via Argo CD
#
# This script sets up the same 5-cluster infrastructure as k3d.sh
# (clusters, networking, Linkerd, multicluster) but instead of
# deploying the application with Helm, it installs Argo CD on the
# platform cluster and lets Argo CD manage the full stack via the
# Application manifests in argo/.
# ============================================================

directory_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
directory_root="$(cd "$directory_script/.." && pwd)"
project_network="tetris-network"

# 5 clusters: 3 gameplay + 1 scoring + 1 platform
cluster_contexts=(
    "k3d-gameplay-east"
    "k3d-gameplay-west"
    "k3d-gameplay-central"
    "k3d-scoring"
    "k3d-platform"
)

# Cluster roles (parallel array)
cluster_roles=(
    "gameplay"
    "gameplay"
    "gameplay"
    "scoring"
    "platform"
)

# Images
dashboard_image_tag="dashboard:local"
agent_image_tag="agent:local"
game_image_tag="game:local"
game_api_image_tag="game-api:local"
leaderboard_api_image_tag="leaderboard-api:local"

application_namespace="tetris"

# Port mapping per cluster (game LB port, dashboard LB port, Argo CD port, API port)
cluster_game_ports=(8080 8081 8082 8083 0)
cluster_dash_ports=(0    0    0    0    9090)
cluster_argocd_ports=(0  0    0    0    9091)
cluster_api_ports=(6550  6551 6552 6553 6554)

echo "============================================"
echo "  Tetris Rush - k3d 5-Cluster Setup"
echo "  (Argo CD mode)"
echo "============================================"
echo ""

# ============================================================
# Check dependencies
# ============================================================

if ! command -v k3d &>/dev/null; then
    echo "Error: k3d is not installed. Please install it from https://k3d.io/" >&2
    exit 1
fi
if ! command -v kubectl &>/dev/null; then
    echo "Error: kubectl is not installed. Please install it from https://kubernetes.io/docs/tasks/tools/" >&2
    exit 1
fi
if ! command -v docker &>/dev/null; then
    echo "Error: Docker is not installed. Please install it from https://www.docker.com/get-started" >&2
    exit 1
fi
if ! command -v helm &>/dev/null; then
    echo "Error: Helm is not installed. Please install it from https://helm.sh/docs/intro/install/" >&2
    exit 1
fi
if [ -z "${BUOYANT_LICENSE:-}" ]; then
    echo "Error: BUOYANT_LICENSE environment variable is not set. Please set it to your Linkerd Enterprise license key." >&2
    exit 1
fi

# ============================================================
# K3D cluster configuration
# ============================================================

echo "Detecting existing clusters..."
k3d_clusters=$(k3d cluster list -o json | jq -r '.[].name')
for cluster in $k3d_clusters; do
    echo "Deleting existing cluster: $cluster"
    k3d cluster delete "$cluster"
done

echo "Creating Docker network..."
if ! docker network ls --format '{{.Name}}' | grep -q "${project_network}"; then
    docker network create "${project_network}"
    echo "Network created: ${project_network}"
else
    echo "Network already exists: ${project_network}"
fi

echo "Creating clusters..."
for i in "${!cluster_contexts[@]}"; do
    context="${cluster_contexts[$i]}"
    cluster_name="${context#k3d-}"
    api_port="${cluster_api_ports[$i]}"
    game_port="${cluster_game_ports[$i]}"
    dash_port="${cluster_dash_ports[$i]}"
    argocd_port="${cluster_argocd_ports[$i]}"

    port_args=()
    if [[ "$game_port" -gt 0 ]]; then
        port_args+=(-p "${game_port}:80@loadbalancer")
    fi
    if [[ "$dash_port" -gt 0 ]]; then
        port_args+=(-p "${dash_port}:8090@loadbalancer")
    fi
    if [[ "$argocd_port" -gt 0 ]]; then
        port_args+=(-p "${argocd_port}:443@loadbalancer")
    fi

    echo "Creating cluster: $cluster_name"
    k3d cluster create "$cluster_name" \
        --network "${project_network}" \
        --api-port "$api_port" \
        "${port_args[@]}" \
        --k3s-arg "--disable=traefik@server:0" \
        --k3s-arg "--cluster-cidr=10.$((i + 1))0.0.0/16@server:0" \
        --k3s-arg "--service-cidr=10.11${i}.0.0/16@server:0"
done

echo "Waiting for clusters to be ready..."
for context in "${cluster_contexts[@]}"; do
    kubectl --context="$context" wait node --all --for=condition=Ready --timeout=2m
    echo "  Cluster ready: $context"
done

# ============================================================
# Routes
# ============================================================

echo "Adding node-level cross-cluster routes..."
for src in "${cluster_contexts[@]}"; do
    for dst in "${cluster_contexts[@]}"; do
        [ "$src" = "$dst" ] && continue
        src_nodes=$(kubectl --context="$src" get node -o json | jq -r '.items[] | .metadata.name + "\t" + .spec.podCIDR + "\t" + (.status.addresses[] | select(.type == "InternalIP") | .address)')
        dst_nodes=$(kubectl --context="$dst" get node -o json | jq -r '.items[] | .metadata.name + "\t" + .spec.podCIDR + "\t" + (.status.addresses[] | select(.type == "InternalIP") | .address)')
        while IFS=$'\t' read -r src_name src_cidr src_ip; do
            while IFS=$'\t' read -r dst_name dst_cidr dst_ip; do
                docker exec "$src_name" ip route add "$dst_cidr" via "$dst_ip" 2>/dev/null || true
                docker exec "$dst_name" ip route add "$src_cidr" via "$src_ip" 2>/dev/null || true
            done <<< "$dst_nodes"
        done <<< "$src_nodes"
    done
done
echo "Node routes configured"

echo "Updating CoreDNS hosts..."
for context in "${cluster_contexts[@]}"; do
    coredns_cm=$(kubectl --context="$context" get cm coredns -n kube-system -o yaml | grep -Ev "creationTimestamp|resourceVersion|uid")
    echo "$coredns_cm" | sed 's/host.k3d.internal/host.k3d.internal kubernetes/g' | kubectl --context="$context" apply -f - -n kube-system
    kubectl --context="$context" rollout restart deploy coredns -n kube-system
done
echo "CoreDNS updated"

# ============================================================
# Linkerd identity certificates
# ============================================================

echo "Download Linkerd CLI..."
curl --proto '=https' --tlsv1.2 -sSfL https://enterprise.buoyant.io/install | sh
export PATH="$HOME/.linkerd2/bin:$PATH"

echo "Generating identity certificates..."
certificate_directory=$(mktemp -d)
step certificate create root.linkerd.cluster.local "$certificate_directory/ca.crt" "$certificate_directory/ca.key" --profile root-ca --no-password --insecure --force
step certificate create identity.linkerd.cluster.local "$certificate_directory/issuer.crt" "$certificate_directory/issuer.key" --ca "$certificate_directory/ca.crt" --ca-key "$certificate_directory/ca.key" --profile intermediate-ca --not-after 8760h --no-password --insecure --force

echo "Certificate values will be injected into Argo CD manifests..."

# ============================================================
# Build and import container images
# ============================================================

echo "Building container images"
docker build -t "$dashboard_image_tag"          -f "$directory_root/dashboard/Dockerfile"              "$directory_root"
docker build -t "$agent_image_tag"              -f "$directory_root/api/agent/Dockerfile"              "$directory_root"
docker build -t "$game_image_tag"               -f "$directory_root/tetris/Dockerfile"                 "$directory_root"
docker build -t "$game_api_image_tag"           -f "$directory_root/api/tetris-api/Dockerfile"         "$directory_root"
docker build -t "$leaderboard_api_image_tag"    -f "$directory_root/api/leaderboard-api/Dockerfile"    "$directory_root"

echo "Importing images into k3d clusters"
for i in "${!cluster_contexts[@]}"; do
    cluster="${cluster_contexts[$i]}"
    role="${cluster_roles[$i]}"
    cluster_name="${cluster#k3d-}"

    case "$role" in
        gameplay)
            k3d image import "$game_image_tag"     -c "$cluster_name"
            k3d image import "$game_api_image_tag"  -c "$cluster_name"
            k3d image import "$agent_image_tag"     -c "$cluster_name"
            ;;
        scoring)
            k3d image import "$leaderboard_api_image_tag" -c "$cluster_name"
            ;;
        platform)
            k3d image import "$dashboard_image_tag" -c "$cluster_name"
            k3d image import "$agent_image_tag"     -c "$cluster_name"
            ;;
    esac
    echo "Images imported into $cluster ($role)"
done

# ============================================================
# Argo CD installation
# ============================================================

echo "Installing Argo CD on the platform cluster..."
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update argo
helm install argocd argo/argo-cd \
    --kube-context=k3d-platform \
    --namespace argocd \
    --create-namespace \
    --set server.service.type=LoadBalancer \
    --wait \
    --timeout 3m

# ============================================================
# Register remote clusters with Argo CD
# ============================================================

echo "Registering remote clusters with Argo CD..."
remote_clusters=("k3d-gameplay-east" "k3d-gameplay-west" "k3d-gameplay-central" "k3d-scoring")
for remote in "${remote_clusters[@]}"; do
    remote_name="${remote#k3d-}"
    remote_node="k3d-${remote_name}-server-0"
    remote_api_ip=$(docker inspect "$remote_node" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')

    # Create a service account for Argo CD on the remote cluster
    kubectl --context="$remote" create serviceaccount argocd-manager -n kube-system 2>/dev/null || true
    kubectl --context="$remote" create clusterrolebinding argocd-manager \
        --clusterrole=cluster-admin --serviceaccount=kube-system:argocd-manager 2>/dev/null || true

    # Create a long-lived token secret for the service account
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

    # Wait for the token to be populated
    for _ in $(seq 1 30); do
        token=$(kubectl --context="$remote" -n kube-system get secret argocd-manager-token -o jsonpath='{.data.token}' 2>/dev/null || true)
        if [[ -n "$token" ]]; then break; fi
        sleep 1
    done
    token=$(echo "$token" | base64 -d)

    # Create the Argo CD cluster secret on the platform cluster
    cat <<EOSECRET | kubectl --context=k3d-platform apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: cluster-${remote_name}
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
type: Opaque
stringData:
  name: "${remote_name}"
  server: "https://${remote_api_ip}:6443"
  config: |
    {
      "bearerToken": "${token}",
      "tlsClientConfig": {
        "insecure": true
      }
    }
EOSECRET
    echo "  Registered cluster: $remote_name (${remote_api_ip})"
done

# ============================================================
# Apply Argo CD manifests
# ============================================================

echo "Generating Argo CD manifests with actual cluster server URLs..."
argo_temp=$(mktemp -d)
cp "$directory_root"/argo/*.yaml "$argo_temp/"

# Replace placeholder server URLs with actual Docker-internal IPs
for remote in "${remote_clusters[@]}"; do
    remote_name="${remote#k3d-}"
    remote_node="k3d-${remote_name}-server-0"
    remote_api_ip=$(docker inspect "$remote_node" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
    sed -i.bak "s|https://${remote_name}:6443|https://${remote_api_ip}:6443|g" "$argo_temp"/*.yaml
done

# Platform cluster uses in-cluster URL
sed -i.bak "s|https://platform:6443|https://kubernetes.default.svc|g" "$argo_temp"/*.yaml

# Inject certificate values into the Linkerd control-plane ApplicationSet
CERT_DIR="$certificate_directory" perl -i -pe '
    BEGIN {
        sub slurp { local $/; open my $f, "<", $_[0] or die $!; <$f> }
        $dir = $ENV{CERT_DIR};
        $trust = slurp("$dir/ca.crt");
        $crt   = slurp("$dir/issuer.crt");
        $key   = slurp("$dir/issuer.key");
        for ($trust, $crt, $key) { chomp; s/\n/\\n/g; $_ = qq{"$_"} }
    }
    s/REPLACE_TRUST_ANCHOR_PEM/$trust/g;
    s/REPLACE_ISSUER_CRT_PEM/$crt/g;
    s/REPLACE_ISSUER_KEY_PEM/$key/g;
' "$argo_temp/linkerd-control-plane.yaml"
rm -f "$argo_temp"/*.bak

echo "Applying Argo CD manifests..."
kubectl --context=k3d-platform apply -f "$argo_temp/"
rm -rf "$argo_temp"

# ============================================================
# Multicluster links (dynamic — cannot be in Git)
# ============================================================

# ============================================================
# Final Output
# ============================================================
echo ""
echo "  ======================================"
echo ""
echo "All clusters deployed successfully!"
echo "Argo CD is managing the application stack."
echo ""
echo "Tetris (players):"
gameplay_contexts=("k3d-gameplay-east" "k3d-gameplay-west" "k3d-gameplay-central")
gameplay_ports=(8080 8081 8082)
for i in "${!gameplay_contexts[@]}"; do
    cluster_name="${gameplay_contexts[$i]#k3d-}"
    echo "  http://${cluster_name}.localhost:${gameplay_ports[$i]}"
done
echo ""
echo "Dashboard (presenter):"
echo "  http://platform.localhost:9090"
echo ""
echo "Argo CD:"
echo "  https://platform.localhost:9091"
echo "  Username: admin"
echo -n "  Password: "
for _ in $(seq 1 30); do
    pw=$(kubectl --context=k3d-platform -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' 2>/dev/null || true)
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
echo "  CLUSTERS=(k3d-gameplay-east k3d-gameplay-west k3d-gameplay-central k3d-scoring k3d-platform)"
echo '  for src in "${CLUSTERS[@]}"; do'
echo '    gw_ip=$(kubectl --context="$src" -n linkerd-multicluster get svc linkerd-gateway -o jsonpath='"'"'{.status.loadBalancer.ingress[0].ip}'"'"')'
echo '    gw_port=$(kubectl --context="$src" -n linkerd-multicluster get svc linkerd-gateway -o jsonpath='"'"'{.spec.ports[?(@.name=="mc-gateway")].port}'"'"')'
echo '    src_node="${src#k3d-}"'
echo '    src_api_ip=$(docker inspect "k3d-${src_node}-server-0" --format '"'"'{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'"'"')'
echo '    for dst in "${CLUSTERS[@]}"; do'
echo '      [ "$src" = "$dst" ] && continue'
echo '      linkerd --context="$src" multicluster link-gen \'
echo '        --cluster-name "${src#k3d-}" \'
echo '        --gateway-addresses "$gw_ip" \'
echo '        --gateway-port "$gw_port" \'
echo '        --api-server-address "https://${src_api_ip}:6443" \'
echo '        | kubectl --context="$dst" apply -f -'
echo '    done'
echo '  done'
echo ""
echo "  ======================================"
