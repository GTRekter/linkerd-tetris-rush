#!/bin/bash
set -euo pipefail

# ============================================================
# Environment variables (with defaults)
# ============================================================

directory_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
directory_root="$(cd "$directory_script/.." && pwd)"
project_prefix="vastaya"
project_network="${project_prefix}-network"
cluster_contexts=(
    "k3d-${project_prefix}-ap-east"
    "k3d-${project_prefix}-ap-central"
    "k3d-${project_prefix}-ap-south"
)
dashboard_frontend_image_tag="dashboard:local"
dashboard_api_image_tag="dashboard-api:local"
tetris_frontend_image_tag="tetris:local"
tetris_api_image_tag="tetris-api:local"
application_namespace="vastaya"
application_color_map=(
    "#3b82f6" # blue
    "#8b5cf6" # purple
    "#06b6d4" # cyan
)

echo "============================================"
echo "  Tetris - k3d Local Clusters Setup"
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
    echo "Creating cluster: $context"
    k3d cluster create "${context#k3d-}" \
        --network "${project_network}" \
        --api-port "655${i}" \
        -p "808${i}:80@loadbalancer" \
        -p "909${i}:8090@loadbalancer" \
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
docker build -t "$dashboard_frontend_image_tag" -f "$directory_root/dashboard/Dockerfile"          "$directory_root"
docker build -t "$dashboard_api_image_tag"      -f "$directory_root/api/dashboard-api/Dockerfile" "$directory_root"
docker build -t "$tetris_frontend_image_tag"    -f "$directory_root/tetris/Dockerfile"            "$directory_root"
docker build -t "$tetris_api_image_tag"         -f "$directory_root/api/tetris-api/Dockerfile"    "$directory_root"

echo "Importing images into k3d clusters"
# Dashboard frontend only goes to the first cluster
k3d image import "$dashboard_frontend_image_tag" -c "${cluster_contexts[0]#k3d-}"
echo "Dashboard frontend image imported into ${cluster_contexts[0]}"

# Dashboard API and tetris images go to all clusters
for cluster in "${cluster_contexts[@]}"; do
    k3d image import "$dashboard_api_image_tag"      -c "${cluster#k3d-}"
    k3d image import "$tetris_frontend_image_tag"    -c "${cluster#k3d-}"
    k3d image import "$tetris_api_image_tag"         -c "${cluster#k3d-}"
    echo "Images imported into $cluster"
done

echo "Deploying application with Helm"
dashboard_cluster_name="${cluster_contexts[0]#k3d-}"
dashboard_context="${cluster_contexts[0]}"

# Deploy the first cluster (dashboard + Redis) first
echo "Deploying dashboard cluster: $dashboard_cluster_name"
helm --kube-context="$dashboard_context" upgrade --install tetris "$directory_root/helm/tetris" \
    --namespace "$application_namespace" --create-namespace \
    --set "dashboard.enabled=true" \
    --set "redis.deploy=true" \
    --set "redis.url=redis://redis.${application_namespace}.svc.cluster.local:6379" \
    --set "dashboardFrontend.image.repository=${dashboard_frontend_image_tag%:*}" \
    --set "dashboardFrontend.image.tag=${dashboard_frontend_image_tag#*:}" \
    --set "dashboardApi.image.repository=${dashboard_api_image_tag%:*}" \
    --set "dashboardApi.image.tag=${dashboard_api_image_tag#*:}" \
    --set "tetrisFrontend.image.repository=${tetris_frontend_image_tag%:*}" \
    --set "tetrisFrontend.image.tag=${tetris_frontend_image_tag#*:}" \
    --set "tetrisApi.image.repository=${tetris_api_image_tag%:*}" \
    --set "tetrisApi.image.tag=${tetris_api_image_tag#*:}" \
    --set "cluster.name=${dashboard_cluster_name}" \
    --set "cluster.region=${dashboard_cluster_name}" \
    --set "cluster.color=${application_color_map[0]}" \
    --set "externalUrl=http://${dashboard_cluster_name}.localhost:8080"

# Wait for Redis LoadBalancer IP
echo -n "Waiting for Redis LoadBalancer IP..."
redis_lb_ip=""
while true; do
    redis_lb_ip=$(kubectl --context="$dashboard_context" -n "$application_namespace" get svc redis -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
    if [[ -n "$redis_lb_ip" ]]; then
        echo " $redis_lb_ip"
        break
    fi
    echo -n "."
    sleep 3
done

# Deploy remaining clusters using the Redis LoadBalancer IP
for i in "${!cluster_contexts[@]}"; do
    [ "$i" = "0" ] && continue
    context="${cluster_contexts[$i]}"
    cluster_name="${context#k3d-}"

    echo "Deploying cluster: $cluster_name"
    helm --kube-context="$context" upgrade --install tetris "$directory_root/helm/tetris" \
        --namespace "$application_namespace" --create-namespace \
        --set "dashboard.enabled=false" \
        --set "redis.deploy=false" \
        --set "redis.url=redis://${redis_lb_ip}:6379" \
        --set "dashboardFrontend.image.repository=${dashboard_frontend_image_tag%:*}" \
        --set "dashboardFrontend.image.tag=${dashboard_frontend_image_tag#*:}" \
        --set "dashboardApi.image.repository=${dashboard_api_image_tag%:*}" \
        --set "dashboardApi.image.tag=${dashboard_api_image_tag#*:}" \
        --set "tetrisFrontend.image.repository=${tetris_frontend_image_tag%:*}" \
        --set "tetrisFrontend.image.tag=${tetris_frontend_image_tag#*:}" \
        --set "tetrisApi.image.repository=${tetris_api_image_tag%:*}" \
        --set "tetrisApi.image.tag=${tetris_api_image_tag#*:}" \
        --set "cluster.name=${cluster_name}" \
        --set "cluster.region=${cluster_name}" \
        --set "cluster.color=${application_color_map[$i]}" \
        --set "externalUrl=http://${cluster_name}.localhost:$((8080 + i))"
done

echo "Waiting for application to be ready in all clusters..."
for context in "${cluster_contexts[@]}"; do
    kubectl --context="$context" -n "$application_namespace" rollout restart deploy -n "$application_namespace"
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
for i in "${!cluster_contexts[@]}"; do
    cluster_name="${cluster_contexts[$i]#k3d-}"
    echo "  http://${cluster_name}.localhost:$((8080 + i))"
done
echo ""
echo "Dashboard (presenter):"
echo "  http://${dashboard_cluster_name}.localhost:9090"
echo ""
echo "Kubernetes Resources (presenter):"
for i in "${!cluster_contexts[@]}"; do
    cluster_name="${cluster_contexts[$i]#k3d-}"
    echo "  watch kubectl --context=${cluster_contexts[$i]} get pods,svc,httproutes,server -A"
done
echo "  ======================================"
