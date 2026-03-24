#!/bin/bash
set -euo pipefail

# ============================================================
# Environment variables (with defaults)
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
application_color_map=(
    "#3b82f6" # blue     — gameplay-east
    "#8b5cf6" # purple   — gameplay-west
    "#06b6d4" # cyan     — gameplay-central
    "#f59e0b" # amber    — scoring
    "#10b981" # emerald  — platform
)

# Port mapping per cluster (game LB port, dashboard LB port, API port)
cluster_game_ports=(8080 8081 8082 8083 0)
cluster_dash_ports=(0    0    0    0    9090)
cluster_api_ports=(6550  6551 6552 6553 6554)

echo "============================================"
echo "  Tetris Rush - k3d 5-Cluster Setup"
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

    port_args=()
    if [[ "$game_port" -gt 0 ]]; then
        port_args+=(-p "${game_port}:80@loadbalancer")
    fi
    if [[ "$dash_port" -gt 0 ]]; then
        port_args+=(-p "${dash_port}:8090@loadbalancer")
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
# Linkerd
# ============================================================

echo "Download Linkerd CLI..."
curl --proto '=https' --tlsv1.2 -sSfL https://enterprise.buoyant.io/install | sh
export PATH="$HOME/.linkerd2/bin:$PATH"

echo "Generating identity certificates..."
certificate_directory=$(mktemp -d)
step certificate create root.linkerd.cluster.local "$certificate_directory/ca.crt" "$certificate_directory/ca.key" --profile root-ca --no-password --insecure --force
step certificate create identity.linkerd.cluster.local "$certificate_directory/issuer.crt" "$certificate_directory/issuer.key" --ca "$certificate_directory/ca.crt" --ca-key "$certificate_directory/ca.key" --profile intermediate-ca --not-after 8760h --no-password --insecure --force

for context in "${cluster_contexts[@]}"; do
    echo "Installing Gateway API CRDs"
    kubectl --context="$context" apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml

    echo "Installing Linkerd CRDs..."
    linkerd --context="$context" install --crds | kubectl --context="$context" apply -f -

    echo "Installing Linkerd Control Plane..."
    linkerd --context="$context" install \
        --identity-trust-anchors-file "$certificate_directory/ca.crt" \
        --identity-issuer-certificate-file "$certificate_directory/issuer.crt" \
        --identity-issuer-key-file "$certificate_directory/issuer.key" \
        | kubectl --context="$context" apply -f -

    echo "Waiting for Linkerd to be ready on $context..."
    linkerd --context="$context" check --wait 2m
done

# ============================================================
# Linkerd Multicluster Configuration
# ============================================================

for context in "${cluster_contexts[@]}"; do
    echo "Installing Linkerd Multicluster on $context..."
    echo "Note: We will deploy the gateway even if the network is flat to cover multiple scenarios"

    controller_sets=()
    idx=0
    for other in "${cluster_contexts[@]}"; do
        [ "$other" = "$context" ] && continue
        controller_sets+=(--set "controllers[$idx].link.ref.name=${other#k3d-}")
        idx=$((idx + 1))
    done

    linkerd --context="$context" multicluster install \
        --gateway \
        "${controller_sets[@]}" \
        | kubectl --context="$context" apply -f -
done

echo "Waiting for linkerd-gateway to get an external IP in all clusters..."
for context in "${cluster_contexts[@]}"; do
    echo -n "  Waiting for $context..."
    while true; do
        ip=$(kubectl --context="$context" -n linkerd-multicluster get svc linkerd-gateway -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
        if [[ -n "$ip" ]]; then
            echo " $ip"
            break
        fi
        echo -n "."
        sleep 3
    done
done

for src in "${cluster_contexts[@]}"; do
    gw_ip=$(kubectl --context="$src" -n linkerd-multicluster get svc linkerd-gateway -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
    gw_port=$(kubectl --context="$src" -n linkerd-multicluster get svc linkerd-gateway -o jsonpath='{.spec.ports[?(@.name=="mc-gateway")].port}')
    # Get the internal Docker network IP of the k3d API server node
    src_node="${src#k3d-}"
    src_api_ip=$(docker inspect "k3d-${src_node}-server-0" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
    for dst in "${cluster_contexts[@]}"; do
        [ "$src" = "$dst" ] && continue
        echo "Linking $src into $dst..."
        linkerd --context="$src" multicluster link-gen \
            --cluster-name "${src#k3d-}" \
            --gateway-addresses "$gw_ip" \
            --gateway-port "$gw_port" \
            --api-server-address "https://${src_api_ip}:6443" \
            | kubectl --context="$dst" apply -f -
    done
done

# ============================================================
# Application Setup
# ============================================================

echo "Building container images"
docker build -t "$dashboard_image_tag"          -f "$directory_root/dashboard/Dockerfile"              "$directory_root"
docker build -t "$agent_image_tag"              -f "$directory_root/api/agent/Dockerfile"              "$directory_root"
docker build -t "$game_image_tag"               -f "$directory_root/tetris/Dockerfile"                 "$directory_root"
docker build -t "$game_api_image_tag"           -f "$directory_root/api/tetris-api/Dockerfile"         "$directory_root"
docker build -t "$leaderboard_api_image_tag"    -f "$directory_root/api/leaderboard-api/Dockerfile"    "$directory_root"

echo "Importing images into k3d clusters"
# Import images per cluster role
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
# Helm Deployments
# ============================================================

echo "Deploying application with Helm"

# --- 1) Deploy scoring cluster first (has Redis) ---
scoring_context="k3d-scoring"
echo "Deploying scoring cluster..."
helm --kube-context="$scoring_context" upgrade --install tetris "$directory_root/helm/tetris" \
    --namespace "$application_namespace" --create-namespace \
    --set "game.enabled=false" \
    --set "gameApi.enabled=false" \
    --set "agent.enabled=false" \
    --set "dashboard.enabled=false" \
    --set "leaderboardApi.enabled=true" \
    --set "redis.deploy=true" \
    --set "redis.url=redis://redis.${application_namespace}.svc.cluster.local:6379" \
    --set "cluster.name=scoring" \
    --set "cluster.region=scoring" \
    --set "cluster.color=#f59e0b" \
    --set "externalUrl=http://scoring.localhost:8083"

# Wait for Redis LoadBalancer IP
echo -n "Waiting for Redis LoadBalancer IP..."
redis_lb_ip=""
while true; do
    redis_lb_ip=$(kubectl --context="$scoring_context" -n "$application_namespace" get svc redis -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
    if [[ -n "$redis_lb_ip" ]]; then
        echo " $redis_lb_ip"
        break
    fi
    echo -n "."
    sleep 3
done

# --- 2) Deploy gameplay clusters ---
gameplay_contexts=("k3d-gameplay-east" "k3d-gameplay-west" "k3d-gameplay-central")
gameplay_colors=("#3b82f6" "#8b5cf6" "#06b6d4")
gameplay_ports=(8080 8081 8082)

for i in "${!gameplay_contexts[@]}"; do
    context="${gameplay_contexts[$i]}"
    cluster_name="${context#k3d-}"
    color="${gameplay_colors[$i]}"
    port="${gameplay_ports[$i]}"

    echo "Deploying gameplay cluster: $cluster_name"
    helm --kube-context="$context" upgrade --install tetris "$directory_root/helm/tetris" \
        --namespace "$application_namespace" --create-namespace \
        --set "game.enabled=true" \
        --set "gameApi.enabled=true" \
        --set "agent.enabled=true" \
        --set "dashboard.enabled=false" \
        --set "leaderboardApi.enabled=false" \
        --set "redis.deploy=false" \
        --set "redis.url=redis://${redis_lb_ip}:6379" \
        --set "leaderboardApiUrl=http://leaderboard-api-scoring.${application_namespace}.svc.cluster.local" \
        --set "cluster.name=${cluster_name}" \
        --set "cluster.region=${cluster_name}" \
        --set "cluster.color=${color}" \
        --set "externalUrl=http://${cluster_name}.localhost:${port}"
done

# --- 3) Deploy platform cluster ---
platform_context="k3d-platform"
echo "Deploying platform cluster..."
helm --kube-context="$platform_context" upgrade --install tetris "$directory_root/helm/tetris" \
    --namespace "$application_namespace" --create-namespace \
    --set "game.enabled=false" \
    --set "gameApi.enabled=false" \
    --set "agent.enabled=true" \
    --set "dashboard.enabled=true" \
    --set "leaderboardApi.enabled=false" \
    --set "redis.deploy=false" \
    --set "redis.url=redis://${redis_lb_ip}:6379" \
    --set "cluster.name=platform" \
    --set "cluster.region=platform" \
    --set "cluster.color=#10b981" \
    --set "externalUrl=http://platform.localhost:9090"

echo "Waiting for application to be ready in all clusters..."
for context in "${cluster_contexts[@]}"; do
    kubectl --context="$context" -n "$application_namespace" rollout restart deploy -n "$application_namespace" 2>/dev/null || true
done

# ============================================================
# Final Output
# ============================================================
echo ""
echo "  ======================================"
echo ""
echo "All clusters and application deployed successfully!"
echo ""
echo "Tetris (players):"
for i in "${!gameplay_contexts[@]}"; do
    cluster_name="${gameplay_contexts[$i]#k3d-}"
    echo "  http://${cluster_name}.localhost:${gameplay_ports[$i]}"
done
echo ""
echo "Dashboard (presenter):"
echo "  http://platform.localhost:9090"
echo ""
echo "Kubernetes Resources:"
for context in "${cluster_contexts[@]}"; do
    echo "  watch kubectl --context=${context} get pods,svc,httproutes,server -A"
done
echo "  ======================================"
