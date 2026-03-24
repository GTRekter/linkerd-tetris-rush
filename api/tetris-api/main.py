"""
Tetris Rush — FastAPI backend
==============================
Conference demo for Linkerd multicluster.
Each /api/next-piece request is a real mesh call routed through Linkerd.
Game state is stored in Redis so the agent can read it independently.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import random
import socket
import time
import qrcode
import qrcode.image.svg
import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response



# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CLUSTER_NAME = os.getenv("CLUSTER_NAME", "local-dev")
CLUSTER_COLOR = os.getenv("CLUSTER_COLOR", "#3b82f6")
CLUSTER_REGION = os.getenv("CLUSTER_REGION", "localhost")
EXTERNAL_URL = os.getenv("EXTERNAL_URL", "http://localhost:8000")
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "demo-admin-2024")
POD_NAME = os.getenv("HOSTNAME", socket.gethostname())
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
LEADERBOARD_API_URL = os.getenv("LEADERBOARD_API_URL", "")

PIECE_TYPES = ["I", "O", "T", "S", "Z", "J", "L"]
LINE_SCORES = {0: 0, 1: 100, 2: 300, 3: 500, 4: 800}

# ---------------------------------------------------------------------------
# Redis
# ---------------------------------------------------------------------------

rdb = aioredis.from_url(REDIS_URL, decode_responses=True)
http_client = httpx.AsyncClient(timeout=5.0) if LEADERBOARD_API_URL else None

# All keys are prefixed with the cluster name so multiple clusters can share
# a single Redis instance.  Helper ``k()`` builds the prefixed key.
# Player keys use a global prefix so players work across all clusters.
#
# Keys (after prefix):
#   {cluster}:game:state            hash
#   {cluster}:game:stats            hash
#   {cluster}:game:piece_counts     hash
#   {cluster}:game:cluster          hash
#   global:player:{id}              hash
#   global:players                  set

def k(key: str) -> str:
    """Return a cluster-namespaced Redis key."""
    return f"{CLUSTER_NAME}:{key}"


def gk(key: str) -> str:
    """Return a global (non-cluster-scoped) Redis key."""
    return f"global:{key}"


async def _init_redis():
    """Seed cluster identity and default game state if not present."""
    await rdb.hset(k("game:cluster"), mapping={
        "name": CLUSTER_NAME,
        "color": CLUSTER_COLOR,
        "region": CLUSTER_REGION,
        "pod": POD_NAME,
        "external_url": EXTERNAL_URL,
    })
    if not await rdb.exists(k("game:state")):
        await rdb.hset(k("game:state"), mapping={
            "active_scenario": "httproute",
            "mtls_enabled": "1",
            "interceptor_active": "0",
            "intercepted_count": "0",
            "auth_policy_enabled": "0",
            "auth_deny_rate": "0.35",
            "egress_enabled": "0",
            "artificial_latency_ms": "0",
            "failure_enabled": "0",
            "healthy": "1",
            "traffic_weights": "{}",
        })
    if not await rdb.exists(k("game:stats")):
        await rdb.hset(k("game:stats"), mapping={
            "total_pieces_served": "0",
            "total_requests": "0",
        })


def _b(val) -> bool:
    return str(val) == "1"


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="Tetris Rush")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    await _init_redis()


# ---------------------------------------------------------------------------
# Health & info
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    state = await rdb.hgetall(k("game:state"))
    if not _b(state.get("healthy", "1")):
        raise HTTPException(status_code=503, detail="cluster_down")
    return {"healthy": True, "cluster": CLUSTER_NAME, "pod": POD_NAME}


@app.get("/api/info")
async def info():
    state = await rdb.hgetall(k("game:state"))
    stats = await rdb.hgetall(k("game:stats"))
    piece_counts = await rdb.hgetall(k("game:piece_counts"))
    player_ids = await rdb.smembers(gk("players"))
    cutoff = time.time() - 60
    active = 0
    for pid in player_ids:
        last = await rdb.hget(gk(f"player:{pid}"), "last_seen")
        if last and float(last) > cutoff:
            active += 1

    return {
        "cluster": CLUSTER_NAME,
        "cluster_color": CLUSTER_COLOR,
        "region": CLUSTER_REGION,
        "pod": POD_NAME,
        "healthy": _b(state.get("healthy", "1")),
        "artificial_latency_ms": int(state.get("artificial_latency_ms", 0)),
        "active_scenario": state.get("active_scenario", "httproute"),
        "mtls_enabled": _b(state.get("mtls_enabled", "1")),
        "interceptor_active": _b(state.get("interceptor_active", "0")),
        "intercepted_count": int(state.get("intercepted_count", 0)),
        "auth_policy_enabled": _b(state.get("auth_policy_enabled", "0")),
        "access_policy": state.get("access_policy", "allow"),
        "egress_enabled": _b(state.get("egress_enabled", "0")),
        "multicluster_mode": state.get("multicluster_mode", "federated"),
        "traffic_weights": json.loads(state.get("traffic_weights", "{}")),
        "total_pieces_served": int(stats.get("total_pieces_served", 0)),
        "piece_type_counts": {k: int(v) for k, v in piece_counts.items()},
        "player_count": active,
    }


# ---------------------------------------------------------------------------
# Player join
# ---------------------------------------------------------------------------

@app.post("/api/join")
async def join(req: Request):
    data = await req.json()
    name = (data.get("name") or "Anonymous").strip()[:20]

    if http_client:
        try:
            resp = await http_client.post(f"{LEADERBOARD_API_URL}/api/join", json={"name": name})
            resp.raise_for_status()
            result = resp.json()
            return {"player_id": result["player_id"], "name": result["name"], "cluster": CLUSTER_NAME, "cluster_color": CLUSTER_COLOR}
        except Exception as e:
            print(f"[leaderboard-api] join failed, falling back to local Redis: {e}")

    # Fallback: write directly to Redis
    player_id = "p_" + "".join(random.choices("abcdefghijklmnopqrstuvwxyz0123456789", k=8))
    now = time.time()
    await rdb.hset(gk(f"player:{player_id}"), mapping={
        "name": name,
        "score": "0",
        "lines": "0",
        "level": "1",
        "pieces": "0",
        "clusters_served": "",
        "active": "1",
        "joined_at": str(now),
        "last_seen": str(now),
    })
    await rdb.sadd(gk("players"), player_id)
    return {"player_id": player_id, "name": name, "cluster": CLUSTER_NAME, "cluster_color": CLUSTER_COLOR}


# ---------------------------------------------------------------------------
# Next piece
# ---------------------------------------------------------------------------

@app.get("/api/next-piece")
async def next_piece(player_id: str, request: Request):
    t_start = time.time()
    state = await rdb.hgetall(k("game:state"))

    if not _b(state.get("healthy", "1")):
        raise HTTPException(status_code=503, detail="cluster_down")

    await rdb.hincrby(k("game:stats"), "total_requests", 1)

    latency_ms_setting = int(state.get("artificial_latency_ms", 0))
    if latency_ms_setting > 0:
        await asyncio.sleep(latency_ms_setting / 1000.0)

    # Failure injection — return 503 so Linkerd's failure accrual counts
    # consecutive failures.  After 7 consecutive 5xx responses the proxy
    # ejects the endpoint and shifts traffic to healthy backends.
    if _b(state.get("failure_enabled", "0")):
        raise HTTPException(status_code=503, detail="injected_failure")

    # Auth policy denial
    if state.get("active_scenario") == "auth-policy" and _b(state.get("auth_policy_enabled", "0")):
        deny_rate = float(state.get("auth_deny_rate", "0.35"))
        if random.random() < deny_rate:
            await rdb.hincrby(k("game:stats"), "denied_count", 1)
            raise HTTPException(
                status_code=403,
                detail={
                    "type": "auth_denied",
                    "cluster": CLUSTER_NAME,
                    "cluster_color": CLUSTER_COLOR,
                    "message": f"AuthorizationPolicy: cluster {CLUSTER_NAME} not authorized to serve this request",
                },
            )

    # Pick piece
    if _b(state.get("egress_enabled", "0")) and random.random() < 0.25:
        piece_type = "I"
        egress = True
    else:
        piece_type = random.choice(PIECE_TYPES)
        egress = False

    # mTLS corruption
    corrupted = False
    corrupted_from = piece_type
    if not _b(state.get("mtls_enabled", "1")):
        if random.random() < 0.8:
            corrupted = True
            await rdb.hincrby(k("game:state"), "intercepted_count", 1)
            await rdb.hset(k("game:state"), "interceptor_active", "1")
            alts = [p for p in PIECE_TYPES if p != piece_type]
            piece_type = random.choice(alts)

    latency_ms = int((time.time() - t_start) * 1000)

    # Update player
    p = await rdb.hgetall(gk(f"player:{player_id}"))
    if p:
        pipe = rdb.pipeline()
        pipe.hincrby(gk(f"player:{player_id}"), "pieces", 1)
        pipe.hset(gk(f"player:{player_id}"), "last_seen", str(time.time()))
        served = p.get("clusters_served", "")
        cluster_list = [c for c in served.split(",") if c]
        if CLUSTER_NAME not in cluster_list:
            cluster_list.append(CLUSTER_NAME)
            pipe.hset(gk(f"player:{player_id}"), "clusters_served", ",".join(cluster_list))
        await pipe.execute()

    await rdb.hincrby(k("game:stats"), "total_pieces_served", 1)
    await rdb.hincrby(k("game:piece_counts"), piece_type, 1)

    return {
        "piece_type": piece_type,
        "cluster": CLUSTER_NAME,
        "cluster_color": CLUSTER_COLOR,
        "region": CLUSTER_REGION,
        "pod": POD_NAME,
        "latency_ms": latency_ms,
        "mtls": _b(state.get("mtls_enabled", "1")),
        "corrupted": corrupted,
        "corrupted_from": corrupted_from,
        "egress": egress,
    }


# ---------------------------------------------------------------------------
# Score submission
# ---------------------------------------------------------------------------

@app.post("/api/score")
async def submit_score(req: Request):
    data = await req.json()
    player_id = data.get("player_id")
    lines_cleared = int(data.get("lines_cleared", 0))
    level = int(data.get("level", 1))

    if http_client:
        try:
            resp = await http_client.post(
                f"{LEADERBOARD_API_URL}/api/score",
                json={"player_id": player_id, "lines_cleared": lines_cleared, "level": level},
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            print(f"[leaderboard-api] score failed, falling back to local Redis: {e}")

    # Fallback: write directly to Redis
    p = await rdb.hgetall(gk(f"player:{player_id}"))
    if not p:
        raise HTTPException(status_code=404, detail="player_not_found")

    points = LINE_SCORES.get(min(lines_cleared, 4), 0) * max(level, 1)
    pipe = rdb.pipeline()
    pipe.hincrby(gk(f"player:{player_id}"), "score", points)
    pipe.hincrby(gk(f"player:{player_id}"), "lines", lines_cleared)
    pipe.hset(gk(f"player:{player_id}"), "level", str(level))
    pipe.hset(gk(f"player:{player_id}"), "last_seen", str(time.time()))
    await pipe.execute()

    p = await rdb.hgetall(gk(f"player:{player_id}"))
    return {
        "score": int(p["score"]),
        "lines": int(p["lines"]),
        "level": int(p["level"]),
        "pieces": int(p.get("pieces", 0)),
    }


# ---------------------------------------------------------------------------
# Leaderboard
# ---------------------------------------------------------------------------

@app.get("/api/leaderboard")
async def leaderboard():
    if http_client:
        try:
            resp = await http_client.get(f"{LEADERBOARD_API_URL}/api/leaderboard")
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            print(f"[leaderboard-api] leaderboard failed, falling back to local Redis: {e}")

    # Fallback: read directly from Redis
    player_ids = await rdb.smembers(gk("players"))
    players = []
    for pid in player_ids:
        p = await rdb.hgetall(gk(f"player:{pid}"))
        if p:
            players.append(p)
    players.sort(key=lambda p: int(p.get("score", 0)), reverse=True)
    return [
        {"name": p["name"], "score": int(p["score"]), "lines": int(p["lines"]), "level": int(p["level"])}
        for p in players[:20]
    ]


# ---------------------------------------------------------------------------
# QR code
# ---------------------------------------------------------------------------

@app.get("/api/qr")
async def qr_code():
    url = f"{EXTERNAL_URL}/play"
    qr = qrcode.QRCode(version=1, box_size=8, border=2)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(image_factory=qrcode.image.svg.SvgImage)
    buf = io.BytesIO()
    img.save(buf)
    return Response(content=buf.getvalue(), media_type="image/svg+xml")


# ---------------------------------------------------------------------------
# Admin endpoints
# ---------------------------------------------------------------------------

def _check_token(data: dict):
    if data.get("token") != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="invalid_token")


@app.post("/api/admin/toggle-health")
async def toggle_health(req: Request):
    data = await req.json()
    _check_token(data)
    cur = _b(await rdb.hget(k("game:state"), "healthy"))
    await rdb.hset(k("game:state"), "healthy", "0" if cur else "1")
    return {"healthy": not cur}


@app.post("/api/admin/set-latency")
async def set_latency(req: Request):
    data = await req.json()
    _check_token(data)
    ms = int(data.get("latency_ms", 0))
    await rdb.hset(k("game:state"), "artificial_latency_ms", str(ms))
    return {"latency_ms": ms}


@app.post("/api/admin/toggle-failure")
async def toggle_failure(req: Request):
    data = await req.json()
    _check_token(data)
    current = _b((await rdb.hget(k("game:state"), "failure_enabled")) or "0")
    new_val = "0" if current else "1"
    await rdb.hset(k("game:state"), "failure_enabled", new_val)
    return {"failure_enabled": new_val == "1"}


@app.post("/api/admin/set-scenario")
async def set_scenario(req: Request):
    data = await req.json()
    _check_token(data)
    scenario = data.get("scenario", "httproute")
    await rdb.hset(k("game:state"), "active_scenario", scenario)
    return {"scenario": scenario}


@app.post("/api/admin/toggle-mtls")
async def toggle_mtls(req: Request):
    data = await req.json()
    _check_token(data)
    cur = _b(await rdb.hget(k("game:state"), "mtls_enabled"))
    new_val = not cur
    mapping = {"mtls_enabled": "1" if new_val else "0"}
    if new_val:
        mapping["interceptor_active"] = "0"
    await rdb.hset(k("game:state"), mapping=mapping)
    return {"mtls_enabled": new_val}


@app.post("/api/admin/toggle-auth-policy")
async def toggle_auth_policy(req: Request):
    data = await req.json()
    _check_token(data)
    cur = _b(await rdb.hget(k("game:state"), "auth_policy_enabled"))
    await rdb.hset(k("game:state"), "auth_policy_enabled", "0" if cur else "1")
    return {"auth_policy_enabled": not cur}


@app.post("/api/admin/toggle-egress")
async def toggle_egress(req: Request):
    data = await req.json()
    _check_token(data)
    cur = _b(await rdb.hget(k("game:state"), "egress_enabled"))
    await rdb.hset(k("game:state"), "egress_enabled", "0" if cur else "1")
    return {"egress_enabled": not cur}


@app.post("/api/admin/set-weights")
async def set_weights(req: Request):
    data = await req.json()
    _check_token(data)
    weights = data.get("weights", {})
    await rdb.hset(k("game:state"), "traffic_weights", json.dumps(weights))
    return {"weights": weights}


@app.post("/api/admin/reset")
async def reset_game(req: Request):
    data = await req.json()
    _check_token(data)
    # Delete all players
    player_ids = await rdb.smembers(gk("players"))
    if player_ids:
        pipe = rdb.pipeline()
        for pid in player_ids:
            pipe.delete(gk(f"player:{pid}"))
        pipe.delete(gk("players"))
        await pipe.execute()
    await rdb.hset(k("game:stats"), mapping={"total_pieces_served": "0", "total_requests": "0"})
    await rdb.delete(k("game:piece_counts"))
    await rdb.hset(k("game:state"), mapping={"intercepted_count": "0", "interceptor_active": "0"})
    return {"reset": True}
