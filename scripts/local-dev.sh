#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Local development - run the full stack without Kubernetes
#
# Modes:
#   ./scripts/local-dev.sh              # backend only (port 8000)
#   ./scripts/local-dev.sh --ui         # backend + React dev server (ports 8000 + 3000)
#   ./scripts/local-dev.sh --multi      # 3 simulated clusters (ports 8001-8003)
#   ./scripts/local-dev.sh --docker     # build and run the production container
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
export CLUSTER_NAME="${CLUSTER_NAME:-local-dev}"
export CLUSTER_COLOR="${CLUSTER_COLOR:-#3b82f6}"
export CLUSTER_REGION="${CLUSTER_REGION:-localhost}"
export EXTERNAL_URL="${EXTERNAL_URL:-http://localhost:8000}"
export ADMIN_TOKEN="${ADMIN_TOKEN:-demo-admin-2024}"

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Run Tetris locally for development.

Options:
  (no flag)     Interactive prompt: choose Tetris or Dashboard frontend
  --ui          Start backend + Tetris React dev server (hot reload on port 3000)
  --dashboard   Start backend + Dashboard React dev server (hot reload on port 3000)
  --multi       Simulate 3 clusters locally (ports 8001, 8002, 8003)
  --docker      Build the Docker image and run it
  -h, --help    Show this help message

Environment variables:
  CLUSTER_NAME    Cluster name shown in UI       (default: local-dev)
  CLUSTER_COLOR   Hex color for this cluster      (default: #3b82f6)
  CLUSTER_REGION  Region label                    (default: localhost)
  EXTERNAL_URL    Public URL for QR code          (default: http://localhost:8000)
  ADMIN_TOKEN     Token for admin controls        (default: demo-admin-2024)
EOF
}

REDIS_CONTAINER="tetris-redis"
PYTHON=""
VENV_DIR="$ROOT_DIR/.venv"

check_python() {
    if command -v python3 &>/dev/null; then
        PYTHON="python3"
    elif command -v python &>/dev/null; then
        PYTHON="python"
    else
        echo "Error: python3 is required. Install it from https://www.python.org/" >&2
        exit 1
    fi
}

check_node() {
    if ! command -v node &>/dev/null; then
        echo "Error: Node.js is required. Install it from https://nodejs.org/" >&2
        exit 1
    fi
}

ensure_venv() {
    if [ ! -d "$VENV_DIR" ]; then
        echo "Creating virtual environment in .venv..."
        $PYTHON -m venv "$VENV_DIR"
    fi
    # shellcheck disable=SC1091
    source "$VENV_DIR/bin/activate"
    PYTHON="python"
}

install_python_deps() {
    ensure_venv
    echo "Installing Python dependencies..."
    $PYTHON -m pip install -q -r "$ROOT_DIR/api/tetris-api/requirements.txt"
}

ensure_redis() {
    if ! command -v docker &>/dev/null; then
        echo "Error: Docker is required to run Redis. Install it from https://docs.docker.com/get-docker/" >&2
        exit 1
    fi
    if docker inspect "$REDIS_CONTAINER" &>/dev/null; then
        # Verify the container has the host port mapping for 6379
        local bound_port
        bound_port="$(docker inspect -f '{{(index (index .NetworkSettings.Ports "6379/tcp") 0).HostPort}}' "$REDIS_CONTAINER" 2>/dev/null || true)"
        if [ "$bound_port" != "6379" ]; then
            echo "Recreating Redis container with correct port mapping..."
            docker rm -f "$REDIS_CONTAINER" >/dev/null
            docker run -d --name "$REDIS_CONTAINER" -p 6379:6379 redis:alpine >/dev/null
        elif [ "$(docker inspect -f '{{.State.Running}}' "$REDIS_CONTAINER")" != "true" ]; then
            echo "Starting existing Redis container..."
            docker start "$REDIS_CONTAINER" >/dev/null
        else
            echo "Redis already running."
        fi
    else
        echo "Starting Redis container..."
        docker run -d --name "$REDIS_CONTAINER" -p 6379:6379 redis:alpine >/dev/null
    fi
}

# --- Interactive chooser (default) ---
run_interactive() {
    echo ""
    echo "  Which app do you want to run?"
    echo ""
    echo "    1) Tetris   — the game frontend (port 3000)"
    echo "    2) Dashboard — the presenter/admin dashboard (port 3000)"
    echo ""
    printf "  Enter choice [1/2]: "
    read -r choice
    case "$choice" in
        2|dashboard) run_dashboard ;;
        *)           run_with_ui ;;
    esac
}

# --- Backend + React dev server ---
run_with_ui() {
    check_python
    check_node
    install_python_deps
    ensure_redis

    echo ""
    echo "  Tetris - Full Stack Development"
    echo "  ================================"
    echo "  React UI:  http://localhost:3000  (hot reload)"
    echo "  Backend:   http://localhost:8000"
    echo ""

    # Start backend in background
    cd "$ROOT_DIR/api/tetris-api"
    $PYTHON -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
    BACKEND_PID=$!

    # Start React dev server
    cd "$ROOT_DIR/tetris/client"
    if [ ! -d "node_modules" ]; then
        echo "Installing frontend dependencies..."
        yarn install
    fi

    # Trap to kill backend when React server exits
    trap "kill $BACKEND_PID 2>/dev/null" EXIT
    yarn start
}

# --- Backend + Dashboard dev server ---
run_dashboard() {
    check_python
    check_node
    install_python_deps
    ensure_redis

    echo ""
    echo "  Dashboard - Full Stack Development"
    echo "  ===================================="
    echo "  React UI:  http://localhost:3000  (hot reload)"
    echo "  Backend:   http://localhost:8000"
    echo ""

    # Start backend in background
    cd "$ROOT_DIR/api/tetris-api"
    $PYTHON -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
    BACKEND_PID=$!

    # Start Dashboard React dev server
    cd "$ROOT_DIR/dashboard/client"
    if [ ! -d "node_modules" ]; then
        echo "Installing dashboard dependencies..."
        yarn install
    fi

    # Trap to kill backend when React server exits
    trap "kill $BACKEND_PID 2>/dev/null" EXIT
    yarn start
}

# --- Simulate 3 clusters ---
run_multi() {
    check_python
    install_python_deps
    ensure_redis

    echo ""
    echo "  Tetris - Multi-Cluster Simulation"
    echo "  =================================="
    echo "  us-east:   http://localhost:8001  (blue)"
    echo "  eu-west:   http://localhost:8002  (purple)"
    echo "  ap-south:  http://localhost:8003  (cyan)"
    echo ""
    echo "  Dashboard: http://localhost:8001/dashboard"
    echo "  (Add http://localhost:8002 and http://localhost:8003 via the sidebar)"
    echo ""

    cd "$ROOT_DIR/api/tetris-api"

    CLUSTER_NAME=us-east CLUSTER_COLOR="#3b82f6" CLUSTER_REGION="US East" \
        EXTERNAL_URL=http://localhost:8001 ADMIN_TOKEN="$ADMIN_TOKEN" \
        $PYTHON -m uvicorn main:app --host 0.0.0.0 --port 8001 &

    CLUSTER_NAME=eu-west CLUSTER_COLOR="#8b5cf6" CLUSTER_REGION="EU West" \
        EXTERNAL_URL=http://localhost:8002 ADMIN_TOKEN="$ADMIN_TOKEN" \
        $PYTHON -m uvicorn main:app --host 0.0.0.0 --port 8002 &

    CLUSTER_NAME=ap-south CLUSTER_COLOR="#06b6d4" CLUSTER_REGION="AP South" \
        EXTERNAL_URL=http://localhost:8003 ADMIN_TOKEN="$ADMIN_TOKEN" \
        $PYTHON -m uvicorn main:app --host 0.0.0.0 --port 8003 &

    trap "kill $(jobs -p) 2>/dev/null" EXIT
    echo "All 3 clusters running. Press Ctrl+C to stop all."
    wait
}

# --- Docker build and run ---
run_docker() {
    if ! command -v docker &>/dev/null; then
        echo "Error: Docker is required. Install it from https://docs.docker.com/get-docker/" >&2
        exit 1
    fi

    echo "Building Docker image..."
    docker build -t game:local -f "$ROOT_DIR/tetris/Dockerfile" "$ROOT_DIR"

    echo ""
    echo "  Tetris - Docker"
    echo "  ================"
    echo "  React UI: http://localhost:8080"
    echo "  Backend:  http://localhost:8000"
    echo ""

    docker run --rm \
        -p 8080:80 -p 8000:8000 \
        -e CLUSTER_NAME="$CLUSTER_NAME" \
        -e CLUSTER_COLOR="$CLUSTER_COLOR" \
        -e CLUSTER_REGION="$CLUSTER_REGION" \
        -e EXTERNAL_URL=http://localhost:8080 \
        -e ADMIN_TOKEN="$ADMIN_TOKEN" \
        game:local
}

# --- Parse arguments ---
case "${1:-}" in
    --ui)        run_with_ui ;;
    --dashboard) run_dashboard ;;
    --multi)     run_multi ;;
    --docker)    run_docker ;;
    -h|--help)   usage ;;
    "")          run_interactive ;;
    *)           echo "Unknown option: $1"; usage; exit 1 ;;
esac
