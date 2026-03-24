# Demo Modules

Tetris has five live demo modules, each showcasing a different Linkerd capability. The presenter switches between them on the dashboard at `/dashboard`. Every module is reflected immediately in what players see on their phones.

---

## The core mechanic

Every Tetris piece is fetched via a real HTTP request:

```
GET /api/next-piece?player_id=...
```

This request travels through the Linkerd service mesh. The federated `tetris-api` service aggregates endpoints from all linked clusters, and Linkerd load-balances across them. Each piece that arrives on a player's board carries a cluster badge showing which cluster served it, plus the actual measured latency.

When attendees scan the QR code, they hit the dashboard's `/go` endpoint which distributes them across different cluster frontends using round-robin (see [architecture.md](architecture.md) for the full redirect flow). This means different players are initially connected to different clusters, making the multicluster behavior visible even before traffic splitting is demonstrated.

This is the core metaphor: **a Tetris piece = one API request through the mesh**. Every Linkerd behavior — latency, mTLS, auth denial, failover — shows up directly as a game effect.

For the complete request flow diagrams, Redis data model, and component architecture, see [architecture.md](architecture.md).

---

## Module 1 — Traffic Split

**What it showcases:** Linkerd's `TrafficSplit` SMI resource for weighted traffic distribution across multiple backends.

### What happens in the cluster

An `HTTPRoute` resource on ap-east distributes `/api/next-piece` requests across three backends:

```yaml
backendRefs:
  - name: tetris-api                       # local — ap-east
    weight: 1
  - name: tetris-api-vastaya-ap-central    # mirrored from ap-central
    weight: 1
  - name: tetris-api-vastaya-ap-south      # mirrored from ap-south
    weight: 1
```

The mirrored services (`tetris-api-vastaya-ap-central`, `tetris-api-vastaya-ap-south`) are created automatically by Linkerd's service mirror controller when it detects the appropriate multicluster label on services in the linked clusters.

### What players see

Each piece has a colored badge — blue for ap-east, purple for ap-central, cyan for ap-south. Pieces appear in roughly the same ratio as the configured weights.

### Demo talking points

- Start with equal weights — attendees immediately see three cluster colors
- Slide ap-east to 100% — all badges turn blue instantly
- Slide it back to equal — color distribution rebalances
- Point out: no application changes, no redeploy; only the `HTTPRoute` resource changed

### Linkerd features involved

- **Service mirroring** — the mirror controller watches linked clusters and creates local `ClusterIP` services for each exported service
- **HTTPRoute traffic splitting** — Linkerd's proxy intercepts requests to `tetris-api` and applies the weight distribution defined in the HTTPRoute before forwarding
- **Multicluster gateways** — traffic to `tetris-api-vastaya-ap-central` exits ap-east via its gateway, crosses the network, and enters ap-central via its gateway

---

## Module 2 — Latency

**What it showcases:** Linkerd's observability and how latency injection surfaces in client-perceived behavior; also demonstrates retry budgets when latency causes timeouts.

### What happens in the cluster

The presenter sets artificial latency (0–3000ms) per cluster via the dashboard slider. When a cluster has latency configured, the backend sleeps for that duration before responding to each `/api/next-piece` request:

```python
if game_state.artificial_latency_ms > 0:
    await asyncio.sleep(game_state.artificial_latency_ms / 1000.0)
```

The cluster card on the dashboard shows a live latency badge.

### What players see

When a piece request is routed to a high-latency cluster, the player sees a "Fetching piece…" spinner and a visible pause before the piece appears. The piece badge shows the actual measured latency in milliseconds.

### Demo talking points

- Inject 800ms on ap-central — players served by it visibly stall between pieces
- Point to the dashboard event log — each piece arrival shows its cluster and latency
- Inject 2000ms on ap-south while ap-central is at 0 — demonstrate that players hitting different clusters get very different experiences
- Explain that in production, this latency could come from geographic distance, slow dependencies, or resource contention — Linkerd makes it visible and measurable without instrumentation

### Linkerd features involved

- **Observability** — Linkerd proxies capture per-request latency metrics; the dashboard event log visualizes what Linkerd can surface via its metrics API
- **Retry budgets** — if latency exceeds a timeout threshold, Linkerd can retry on a different backend; the game continues even when one cluster is slow

---

## Module 3 — mTLS

**What it showcases:** Linkerd's automatic mutual TLS — encryption and identity verification on every request — and what happens when it's absent (interception/tampering).

### What happens in the cluster

By default, all requests between Linkerd-injected pods are encrypted with mTLS. Certificates are rotated automatically. No application code changes are required.

When the presenter disables mTLS on a cluster from the dashboard, the backend simulates what a network interceptor could do: it randomly replaces the requested piece type with a different one before responding:

```python
if not game_state.mtls_enabled:
    if random.random() < 0.6:   # 60% of pieces tampered
        corrupted = True
        alts = [p for p in PIECE_TYPES if p != piece_type]
        piece_type = random.choice(alts)
```

The dashboard shows an "interceptor active" indicator and a running count of tampered requests.

### What players see

Pieces arriving from the cluster with mTLS disabled appear corrupted — the player receives a different shape than what was originally generated. On the board, corrupted pieces render in a dark color. Re-enabling mTLS stops the tampering immediately.

### Demo talking points

- With mTLS enabled: "Every request between Linkerd-proxied pods is encrypted and mutually authenticated. No configuration needed — it's on by default."
- Disable mTLS: "Now I'm simulating what a man-in-the-middle on the network can do. Watch the pieces start changing shape."
- Show the dashboard counter incrementing — "Linkerd can tell you exactly how many requests were intercepted."
- Re-enable: "Turning mTLS back on stops it instantly. The certificates rotate automatically every 24 hours."

### Linkerd features involved

- **Automatic mTLS** — Linkerd injects a proxy sidecar that handles all TLS termination transparently; the application never touches certificates
- **Identity** — each workload gets a cryptographic identity (SPIFFE-compatible) issued by Linkerd's identity service; the trust anchor installed at cluster setup is the root of this chain
- **Shared trust anchor** — all three clusters share the same root CA, allowing cross-cluster mTLS without additional configuration

---

## Module 4 — Authorization Policy

**What it showcases:** Linkerd's `AuthorizationPolicy` (or `Server` + `ServerAuthorization`) resources for fine-grained, identity-based access control inside the mesh.

### What happens in the cluster

When the presenter enables the auth policy on a cluster, the backend probabilistically rejects 35% of piece requests with HTTP 403:

```python
if game_state.active_scenario == "auth-policy" and game_state.auth_policy_enabled:
    if random.random() < deny_rate:   # 0.35
        raise HTTPException(status_code=403, detail={
            "type": "auth_denied",
            "message": f"AuthorizationPolicy: cluster {CLUSTER_NAME} not authorized to serve this request",
        })
```

Denied requests are broadcast to the dashboard event log.

### What players see

The piece feed on the player's board shows "DENIED" entries for rejected requests. The game client retries by requesting the next piece from a different cluster (via the TrafficSplit). From the player's perspective, the game continues — they might see a brief delay, but no interruption.

### Demo talking points

- Enable auth policy on one cluster: "I've now applied an AuthorizationPolicy that restricts which workloads can call this cluster's piece service."
- Watch the event log fill with "DENIED": "Linkerd is enforcing this at the proxy level, before the request ever reaches the application."
- Point out the game continues: "Linkerd retries the denied request on an authorized cluster. Players don't notice."
- "Without a service mesh, you'd have to implement this logic in every service. With Linkerd it's a Kubernetes resource."

### Linkerd features involved

- **Authorization policies** — `Server`, `ServerAuthorization`, and `AuthorizationPolicy` resources define which identities can reach which ports/routes
- **Automatic retries** — when a request is denied, Linkerd's retry logic can re-attempt on a different backend, maintaining availability
- **Identity-based access** — policies are enforced based on the cryptographic workload identity, not network address

---

## Module 5 — Resiliency

**What it showcases:** Linkerd's failure detection, failover, and how the mesh keeps traffic flowing when a cluster goes down.

### What happens in the cluster

The presenter clicks "Kill" on a cluster card. This flips the cluster's health state to `false`. The health endpoint immediately returns 503:

```python
@app.get("/api/health")
async def health():
    if not game_state.healthy:
        raise HTTPException(status_code=503, detail="cluster_down")
```

Linkerd's health probing detects the failing endpoint and stops routing new requests to it. The `TrafficSplit` weights are re-distributed across the remaining healthy backends.

Clicking "Revive" restores the cluster. Linkerd detects the health probe succeeding again and gradually re-includes the cluster in the traffic split.

### What players see

The dashboard cluster card goes red with a "DOWN — failover!" event in the log. Traffic flow animation stops showing requests going to that cluster. **Player games continue uninterrupted** — their next piece arrives from one of the healthy clusters, just with a different badge color.

### Demo talking points

- "Right now pieces are flowing to all three clusters." Kill ap-south mid-game.
- "ap-south is down. Watch the dashboard — traffic automatically reroutes to ap-east and ap-central."
- "Every player who was being served by ap-south just got their next piece from a different cluster. Did anyone's game stop? No."
- Revive: "ap-south is back. Linkerd detects the health check passing and starts routing to it again."
- "This is failover at the mesh layer, not at the application layer. No circuit breaker code, no retry logic in the app."

### Linkerd features involved

- **Health probing** — Linkerd probes endpoints via the readiness probe path (`/api/health`) and removes failing endpoints from the load balancer
- **Automatic failover** — when a backend fails, traffic is redistributed to healthy backends without manual intervention
- **Service mirroring recovery** — when a previously failing cluster recovers, the mirror controller detects the change and re-establishes the mirrored service

---

## Bonus — Egress (optional)

**What it showcases:** Linkerd Egress for controlling and observing outbound traffic to external services.

When enabled, 25% of piece requests return an "I" piece flagged as coming from an external egress service — simulating a bonus piece flowing in from outside the mesh. The dashboard marks these pieces distinctly.

Enable via the dashboard or:

```bash
curl -X POST http://localhost:8000/api/admin/toggle-egress \
  -H 'Content-Type: application/json' \
  -d '{"token": "demo-admin-2024"}'
```

---

## Multicluster modes

The dashboard exposes three multicluster modes — **Federated**, **Mirrored**, and **Gateway** — switchable at runtime. Each mode changes the `tetris-api` Service label and reconfigures the HTTPRoute that controls cross-cluster traffic routing.

In all three modes, the `tetris-frontend` proxy targets `tetris-api`. An HTTPRoute attached to `tetris-api` determines where traffic actually goes.

### Federated

**Service label:** `mirror.linkerd.io/federated: member`

Linkerd creates a virtual `tetris-api-federated` service that aggregates endpoints from all linked clusters. The HTTPRoute routes `tetris-api` → `tetris-api-federated`:

```yaml
backendRefs:
  - name: tetris-api-federated
    weight: 1
```

This is the simplest mode — Linkerd handles everything automatically.

### Mirrored

**Service label:** `mirror.linkerd.io/remote-discovery: member`

Linkerd mirrors `tetris-api` into linked clusters. Traffic flows **pod-to-pod** directly, without going through multicluster gateways. The HTTPRoute splits equally across local and mirrored backends:

```yaml
backendRefs:
  - name: tetris-api                       # local
    weight: 1
  - name: tetris-api-vastaya-ap-central    # mirrored
    weight: 1
  - name: tetris-api-vastaya-ap-south      # mirrored
    weight: 1
```

### Gateway

**Service label:** `mirror.linkerd.io/exported: "true"`

Linkerd mirrors `tetris-api` into linked clusters. Traffic flows **through the multicluster gateways**. The HTTPRoute splits equally across local and mirrored backends (same shape as Mirrored):

```yaml
backendRefs:
  - name: tetris-api                       # local
    weight: 1
  - name: tetris-api-vastaya-ap-central    # mirrored
    weight: 1
  - name: tetris-api-vastaya-ap-south      # mirrored
    weight: 1
```

### Switching modes at runtime

Click the mode button on the dashboard, or call the API directly:

```bash
curl -X POST http://localhost:8090/api/admin/set-mode \
  -H 'Content-Type: application/json' \
  -d '{"token": "demo-admin-2024", "mode": "gateway"}'
```

The agent patches the `tetris-api` Service labels and updates the HTTPRoute backends via the Kubernetes API. The change takes effect immediately — no pod restart required.

### Demo talking points

- Start in **Federated**: "Linkerd aggregates endpoints from all clusters into one virtual service — zero configuration."
- Switch to **Mirrored**: "Now we're using remote discovery. Traffic goes pod-to-pod across clusters, no gateway in the path. The HTTPRoute gives us explicit control over the split."
- Switch to **Gateway**: "Same HTTPRoute, but now traffic flows through the multicluster gateways. This is the model you'd use when clusters can't reach each other directly."

### Helm configuration

Set the initial multicluster mode:

```yaml
service:
  mode: federated   # federated | mirrored | gateway
```

Mirrored backend names (e.g., `tetris-api-vastaya-ap-central`, `tetris-api-vastaya-ap-south`) are discovered dynamically by the agent at runtime via Linkerd's service mirror controller — no static backend list is needed in the Helm values.

---

## Module state reference

The active scenario is stored per-cluster in `GameState.active_scenario`. Switching modules via the dashboard calls `POST /api/admin/set-scenario` on all connected clusters simultaneously. Module-specific toggles (mTLS, auth policy, egress) are independent of the active scenario but are most meaningful when the corresponding module tab is selected.

| State field | Type | Default | Modified by |
|---|---|---|---|
| `active_scenario` | string | `httproute` | `set-scenario` |
| `healthy` | bool | `true` | `toggle-health` |
| `artificial_latency_ms` | int | `0` | `set-latency` |
| `mtls_enabled` | bool | `true` | `toggle-mtls` |
| `auth_policy_enabled` | bool | `false` | `toggle-auth-policy` |
| `egress_enabled` | bool | `false` | `toggle-egress` |
| `multicluster_mode` | string | `federated` | `set-mode` |
| `traffic_weights` | dict | `{}` | `set-weights` |
