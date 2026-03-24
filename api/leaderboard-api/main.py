"""
Leaderboard API — scoring microservice
=======================================
Owns all player/score data in Redis.  Deployed on the scoring cluster
and exported via Linkerd multicluster so game-api instances on gameplay
clusters can submit scores and fetch the leaderboard cross-cluster.
"""

from __future__ import annotations

import os
import random
import time

import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "demo-admin-2024")

LINE_SCORES = {0: 0, 1: 100, 2: 300, 3: 500, 4: 800}

# ---------------------------------------------------------------------------
# Redis
# ---------------------------------------------------------------------------

rdb = aioredis.from_url(REDIS_URL, decode_responses=True)


def gk(key: str) -> str:
    """Return a global (non-cluster-scoped) Redis key."""
    return f"global:{key}"


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="Leaderboard API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    return {"healthy": True, "service": "leaderboard-api"}


# ---------------------------------------------------------------------------
# Player join
# ---------------------------------------------------------------------------

@app.post("/api/join")
async def join(req: Request):
    data = await req.json()
    name = (data.get("name") or "Anonymous").strip()[:20]
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
    return {"player_id": player_id, "name": name}


# ---------------------------------------------------------------------------
# Score submission
# ---------------------------------------------------------------------------

@app.post("/api/score")
async def submit_score(req: Request):
    data = await req.json()
    player_id = data.get("player_id")
    lines_cleared = int(data.get("lines_cleared", 0))
    level = int(data.get("level", 1))

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
# Admin reset
# ---------------------------------------------------------------------------

@app.post("/api/admin/reset")
async def reset(req: Request):
    data = await req.json()
    if data.get("token") != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="invalid_token")

    player_ids = await rdb.smembers(gk("players"))
    pipe = rdb.pipeline()
    for pid in player_ids:
        pipe.delete(gk(f"player:{pid}"))
    pipe.delete(gk("players"))
    await pipe.execute()
    return {"reset": True}
