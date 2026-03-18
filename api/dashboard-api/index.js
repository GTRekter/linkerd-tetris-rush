const express = require('express');
const fs = require('fs');
const https = require('https');
const Redis = require('ioredis');

const cors = require('cors');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 80;
const DEPLOYMENT_NAME = process.env.DEPLOYMENT_NAME || 'tetris-api';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'demo-admin-2024';
const CLUSTER_NAME = process.env.CLUSTER_NAME || 'local-dev';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:8001';
const SERVICE_PORT = parseInt(process.env.SERVICE_PORT || '80');
const HTTPROUTE_NAME = process.env.HTTPROUTE_NAME || 'tetris-api';
const MULTICLUSTER_BACKENDS = (process.env.MULTICLUSTER_BACKENDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const redis = new Redis(REDIS_URL);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a cluster-namespaced Redis key. */
function k(cluster, key) { return `${cluster}:${key}`; }

/** Return a global (non-cluster-scoped) Redis key. */
function gk(key) { return `global:${key}`; }

function b(val) { return String(val) === '1'; }

function checkToken(body) {
  if (body.token !== ADMIN_TOKEN) {
    const err = new Error('invalid_token');
    err.status = 403;
    throw err;
  }
}

/** Resolve target cluster name from request body, defaulting to own cluster. */
function targetCluster(body) {
  return body.cluster || CLUSTER_NAME;
}

/** Push an event entry into a cluster's event log (capped at 200 entries). */
async function pushLog(cluster, text) {
  const entry = JSON.stringify({ time: new Date().toISOString(), cluster, text });
  await redis.lpush(k(cluster, 'event:log'), entry);
  await redis.ltrim(k(cluster, 'event:log'), 0, 199);
}

/**
 * Discover all cluster names by scanning Redis for *:game:cluster keys.
 * Each tetris-api writes its identity to {cluster}:game:cluster on startup.
 */
async function clusterNames() {
  const keys = await redis.keys('*:game:cluster');
  return keys.map(key => key.replace(/:game:cluster$/, ''));
}

// ---------------------------------------------------------------------------
// Kubernetes API helper — uses in-cluster service account
// ---------------------------------------------------------------------------

function k8sScalePatch(replicas) {
  return new Promise((resolve, reject) => {
    let token, namespace, caCert;
    try {
      token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
      namespace = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();
      caCert = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    } catch {
      return reject(new Error('Not running in a Kubernetes cluster'));
    }

    const body = JSON.stringify({ spec: { replicas } });

    const req = https.request({
      hostname: 'kubernetes.default.svc',
      port: 443,
      path: `/apis/apps/v1/namespaces/${namespace}/deployments/${DEPLOYMENT_NAME}/scale`,
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/strategic-merge-patch+json',
        'Content-Length': Buffer.byteLength(body),
      },
      ca: caCert,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`k8s API ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Kubernetes API helpers — multicluster mode switching
// ---------------------------------------------------------------------------

/** Label map for each multicluster mode. */
const MODE_LABELS = {
  federated: { 'mirror.linkerd.io/federated': 'member' },
  mirrored:  { 'mirror.linkerd.io/remote-discovery': 'member' },
  gateway:   { 'mirror.linkerd.io/exported': 'true' },
};

/** All label keys across modes — used to clear stale labels. */
const ALL_MODE_LABEL_KEYS = [
  'mirror.linkerd.io/federated',
  'mirror.linkerd.io/remote-discovery',
  'mirror.linkerd.io/exported',
];

/** Read in-cluster service account credentials (cached). */
let _k8sCreds = null;
function k8sCreds() {
  if (_k8sCreds) return _k8sCreds;
  try {
    _k8sCreds = {
      token: fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8'),
      namespace: fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim(),
      ca: fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'),
    };
    return _k8sCreds;
  } catch {
    throw new Error('Not running in a Kubernetes cluster');
  }
}

/** Generic k8s API request. */
function k8sRequest(method, path, body) {
  const creds = k8sCreds();
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'kubernetes.default.svc',
      port: 443,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': method === 'PATCH'
          ? 'application/merge-patch+json'
          : 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      ca: creds.ca,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`k8s API ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Patch the tetris-api Service labels to match the given mode.
 * Removes labels from other modes and applies the new one.
 */
async function patchServiceMode(mode) {
  const creds = k8sCreds();
  const labels = {};
  // Null out all mode labels first, then set the active one
  for (const key of ALL_MODE_LABEL_KEYS) labels[key] = null;
  Object.assign(labels, MODE_LABELS[mode]);

  return k8sRequest('PATCH',
    `/api/v1/namespaces/${creds.namespace}/services/tetris-api`,
    { metadata: { labels } }
  );
}

/**
 * Build the HTTPRoute backendRefs array for the given mode.
 */
function buildBackendRefs(mode) {
  if (mode === 'federated') {
    return [{ name: 'tetris-api-federated', port: SERVICE_PORT, weight: 1 }];
  }
  // mirrored & gateway: local + all mirrored backends, equal weight
  const refs = [{ name: 'tetris-api', port: SERVICE_PORT, weight: 1 }];
  for (const backend of MULTICLUSTER_BACKENDS) {
    refs.push({ name: backend, port: SERVICE_PORT, weight: 1 });
  }
  return refs;
}

/**
 * Patch the HTTPRoute to use the backendRefs for the given mode.
 */
async function patchHTTPRoute(mode) {
  const creds = k8sCreds();
  const backendRefs = buildBackendRefs(mode);

  return k8sRequest('PATCH',
    `/apis/gateway.networking.k8s.io/v1/namespaces/${creds.namespace}/httproutes/${HTTPROUTE_NAME}`,
    { spec: { rules: [{ backendRefs }] } }
  );
}

// ---------------------------------------------------------------------------
// Scale endpoints
// ---------------------------------------------------------------------------

const POD_NAMESPACE = process.env.POD_NAMESPACE || 'default';

/**
 * Forward a scale request to a remote cluster's dashboard-api via Linkerd
 * service mirroring.  The mirrored service is:
 *   dashboard-api-{cluster}.{namespace}.svc.cluster.local
 */
async function proxyScale(cluster, path, body) {
  const url = `http://dashboard-api-${cluster}.${POD_NAMESPACE}.svc.cluster.local${path}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, cluster }),
  });
  if (!resp.ok) throw new Error(`remote ${cluster}: ${resp.status}`);
  return resp.json();
}

app.post('/admin/scale-down', async (req, res) => {
  try {
    const c = targetCluster(req.body);
    if (c === CLUSTER_NAME) {
      await k8sScalePatch(0);
    } else {
      await proxyScale(c, '/admin/scale-down', req.body);
    }
    await redis.hset(k(c, 'game:state'), 'healthy', '0');
    await pushLog(c, 'Scaled down to 0 replicas');
    res.json({ scaled: 0, cluster: c });
  } catch (err) {
    console.error('scale-down failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/scale-up', async (req, res) => {
  const replicas = parseInt(req.body.replicas) || 2;
  try {
    const c = targetCluster(req.body);
    if (c === CLUSTER_NAME) {
      await k8sScalePatch(replicas);
    } else {
      await proxyScale(c, '/admin/scale-up', { ...req.body, replicas });
    }
    await redis.hset(k(c, 'game:state'), 'healthy', '1');
    await pushLog(c, `Scaled up to ${replicas} replicas`);
    res.json({ scaled: replicas, cluster: c });
  } catch (err) {
    console.error('scale-up failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Read endpoints — all from Redis (shared with tetris-api)
// ---------------------------------------------------------------------------

app.get('/api/clusters', async (_req, res) => {
  try {
    const names = await clusterNames();
    const clusters = await Promise.all(names.map(async (name) => {
      const info = await redis.hgetall(k(name, 'game:cluster'));
      return {
        name: info.name || name,
        color: info.color || '#666',
        region: info.region || '?',
        external_url: info.external_url || '',
        self: name === CLUSTER_NAME,
      };
    }));
    res.json(clusters);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Build an info object for a single cluster from Redis. */
async function clusterInfo(name) {
  const [state, stats, cluster, pieceCounts, playerIds] = await Promise.all([
    redis.hgetall(k(name, 'game:state')),
    redis.hgetall(k(name, 'game:stats')),
    redis.hgetall(k(name, 'game:cluster')),
    redis.hgetall(k(name, 'game:piece_counts')),
    redis.smembers(gk('players')),
  ]);

  const cutoff = Date.now() / 1000 - 60;
  let active = 0;
  for (const pid of playerIds) {
    const last = await redis.hget(gk(`player:${pid}`), 'last_seen');
    if (last && parseFloat(last) > cutoff) active++;
  }

  return {
    cluster: cluster.name || name,
    cluster_color: cluster.color || '#666',
    region: cluster.region || '?',
    pod: cluster.pod || '?',
    healthy: b(state.healthy ?? '1'),
    artificial_latency_ms: parseInt(state.artificial_latency_ms || '0'),
    active_scenario: state.active_scenario || 'traffic-split',
    mtls_enabled: b(state.mtls_enabled ?? '1'),
    interceptor_active: b(state.interceptor_active || '0'),
    intercepted_count: parseInt(state.intercepted_count || '0'),
    auth_policy_enabled: b(state.auth_policy_enabled || '0'),
    egress_enabled: b(state.egress_enabled || '0'),
    multicluster_mode: state.multicluster_mode || 'federated',
    traffic_weights: JSON.parse(state.traffic_weights || '{}'),
    total_pieces_served: parseInt(stats.total_pieces_served || '0'),
    piece_type_counts: Object.fromEntries(
      Object.entries(pieceCounts || {}).map(([key, v]) => [key, parseInt(v)])
    ),
    player_count: active,
  };
}

app.get('/api/info', async (_req, res) => {
  try {
    res.json(await clusterInfo(CLUSTER_NAME));
  } catch (err) {
    console.error('info failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/info-all', async (_req, res) => {
  try {
    const names = await clusterNames();
    const results = await Promise.all(names.map(n => clusterInfo(n)));
    res.json(results);
  } catch (err) {
    console.error('info-all failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Per-cluster endpoints
// ---------------------------------------------------------------------------

app.get('/api/clusters/:name/info', async (req, res) => {
  try {
    const name = req.params.name;
    const [state, cluster] = await Promise.all([
      redis.hgetall(k(name, 'game:state')),
      redis.hgetall(k(name, 'game:cluster')),
    ]);
    res.json({
      cluster: cluster.name || name,
      cluster_color: cluster.color || '#666',
      region: cluster.region || '?',
      pod: cluster.pod || '?',
      healthy: b(state.healthy ?? '1'),
      active_scenario: state.active_scenario || 'traffic-split',
      mtls_enabled: b(state.mtls_enabled ?? '1'),
      interceptor_active: b(state.interceptor_active || '0'),
      intercepted_count: parseInt(state.intercepted_count || '0'),
      auth_policy_enabled: b(state.auth_policy_enabled || '0'),
      egress_enabled: b(state.egress_enabled || '0'),
      multicluster_mode: state.multicluster_mode || 'federated',
      traffic_weights: JSON.parse(state.traffic_weights || '{}'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clusters/:name/logs', async (req, res) => {
  try {
    const name = req.params.name;
    const entries = await redis.lrange(k(name, 'event:log'), 0, 99);
    res.json(entries.map(e => JSON.parse(e)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clusters/:name/pieces', async (req, res) => {
  try {
    const name = req.params.name;
    const [stats, pieceCounts] = await Promise.all([
      redis.hgetall(k(name, 'game:stats')),
      redis.hgetall(k(name, 'game:piece_counts')),
    ]);
    res.json({
      total_pieces_served: parseInt(stats.total_pieces_served || '0'),
      piece_type_counts: Object.fromEntries(
        Object.entries(pieceCounts || {}).map(([key, v]) => [key, parseInt(v)])
      ),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clusters/:name/users', async (req, res) => {
  try {
    const playerIds = await redis.smembers(gk('players'));
    const cutoff = Date.now() / 1000 - 60;
    const players = [];
    for (const pid of playerIds) {
      const p = await redis.hgetall(gk(`player:${pid}`));
      if (p && p.name) {
        const active = p.last_seen && parseFloat(p.last_seen) > cutoff;
        players.push({
          id: pid,
          name: p.name,
          score: parseInt(p.score || '0'),
          level: parseInt(p.level || '1'),
          lines: parseInt(p.lines || '0'),
          active,
        });
      }
    }
    res.json({ player_count: players.filter(p => p.active).length, players });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clusters/:name/latency', async (req, res) => {
  try {
    const name = req.params.name;
    const state = await redis.hgetall(k(name, 'game:state'));
    res.json({
      artificial_latency_ms: parseInt(state.artificial_latency_ms || '0'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leaderboard', async (_req, res) => {
  try {
    const players = [];
    const playerIds = await redis.smembers(gk('players'));
    for (const pid of playerIds) {
      const p = await redis.hgetall(gk(`player:${pid}`));
      if (p && p.name) players.push(p);
    }
    players.sort((a, b) => parseInt(b.score || '0') - parseInt(a.score || '0'));
    res.json(players.slice(0, 20).map(p => ({
      name: p.name,
      score: parseInt(p.score || '0'),
      lines: parseInt(p.lines || '0'),
      level: parseInt(p.level || '1'),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/qr', async (_req, res) => {
  try {
    const url = `${DASHBOARD_URL}/go`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 2, width: 256 });
    res.set('Content-Type', 'image/svg+xml').send(svg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Round-robin redirect — distributes QR code scanners across clusters
// ---------------------------------------------------------------------------

app.get('/go', async (_req, res) => {
  try {
    const names = await clusterNames();
    if (!names.length) {
      return res.status(503).send('No clusters available');
    }

    // Atomic counter for round-robin assignment
    const counter = await redis.incr(gk('redirect:counter'));
    const idx = (counter - 1) % names.length;
    const chosen = names.sort()[idx]; // sort for deterministic ordering

    const cluster = await redis.hgetall(k(chosen, 'game:cluster'));
    const targetUrl = `${cluster.external_url || DASHBOARD_URL}/play`;

    res.redirect(302, targetUrl);
  } catch (err) {
    console.error('redirect failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Admin write endpoints — write to Redis
// ---------------------------------------------------------------------------

app.post('/api/admin/toggle-health', async (req, res) => {
  try {
    checkToken(req.body);
    const c = targetCluster(req.body);
    const cur = b(await redis.hget(k(c, 'game:state'), 'healthy'));
    await redis.hset(k(c, 'game:state'), 'healthy', cur ? '0' : '1');
    res.json({ healthy: !cur });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/admin/set-latency', async (req, res) => {
  try {
    checkToken(req.body);
    const c = targetCluster(req.body);
    const ms = parseInt(req.body.latency_ms || '0');
    await redis.hset(k(c, 'game:state'), 'artificial_latency_ms', String(ms));
    await pushLog(c, `Latency set to ${ms}ms`);
    res.json({ latency_ms: ms });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/admin/set-scenario', async (req, res) => {
  try {
    checkToken(req.body);
    const scenario = req.body.scenario || 'httproute';
    // Set scenario on all clusters
    const names = await clusterNames();
    await Promise.all(names.map(c => redis.hset(k(c, 'game:state'), 'active_scenario', scenario)));
    res.json({ scenario });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/admin/set-mode', async (req, res) => {
  try {
    checkToken(req.body);
    const mode = req.body.mode;
    if (!MODE_LABELS[mode]) {
      return res.status(400).json({ error: `invalid mode: ${mode}. Must be federated, mirrored, or gateway` });
    }
    const c = targetCluster(req.body);
    if (c === CLUSTER_NAME) {
      // Local cluster: patch Service labels + HTTPRoute via k8s API
      await patchServiceMode(mode);
      await patchHTTPRoute(mode);
    } else {
      // Remote cluster: proxy via Linkerd service mirroring
      await proxyScale(c, '/api/admin/set-mode', req.body);
    }
    // Store mode in Redis for all clusters
    const names = await clusterNames();
    await Promise.all(names.map(n => redis.hset(k(n, 'game:state'), 'multicluster_mode', mode)));
    await pushLog(c, `Multicluster mode set to ${mode}`);
    res.json({ mode });
  } catch (err) {
    console.error('set-mode failed:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/admin/toggle-mtls', async (req, res) => {
  try {
    checkToken(req.body);
    const c = targetCluster(req.body);
    const cur = b(await redis.hget(k(c, 'game:state'), 'mtls_enabled'));
    const mapping = { mtls_enabled: cur ? '0' : '1' };
    if (!cur) mapping.interceptor_active = '0';
    await redis.hset(k(c, 'game:state'), ...Object.entries(mapping).flat());
    await pushLog(c, `mTLS ${!cur ? 'enabled' : 'disabled'}`);
    res.json({ mtls_enabled: !cur });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/admin/toggle-auth-policy', async (req, res) => {
  try {
    checkToken(req.body);
    const c = targetCluster(req.body);
    const cur = b(await redis.hget(k(c, 'game:state'), 'auth_policy_enabled'));
    await redis.hset(k(c, 'game:state'), 'auth_policy_enabled', cur ? '0' : '1');
    await pushLog(c, `Auth policy ${!cur ? 'enabled' : 'disabled'}`);
    res.json({ auth_policy_enabled: !cur });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/admin/set-auth-policy', async (req, res) => {
  try {
    checkToken(req.body);
    const c = targetCluster(req.body);
    const allowedUsers = req.body.allowed_users || [];
    const enabled = allowedUsers.length > 0;

    await redis.hset(k(c, 'game:state'), 'auth_policy_enabled', enabled ? '1' : '0');
    await redis.hset(k(c, 'game:state'), 'auth_policy_allowed_users', JSON.stringify(allowedUsers));

    if (enabled) {
      // Deploy AuthorizationPolicy + Server via k8s API
      try {
        const creds = k8sCreds();
        const ns = creds.namespace;

        // Create/update Server resource
        const server = {
          apiVersion: 'policy.linkerd.io/v1beta3',
          kind: 'Server',
          metadata: {
            name: `tetris-api-server-${c}`,
            namespace: ns,
          },
          spec: {
            podSelector: { matchLabels: { app: 'tetris-api' } },
            port: SERVICE_PORT,
          },
        };

        // Create/update AuthorizationPolicy
        const authPolicy = {
          apiVersion: 'policy.linkerd.io/v1alpha1',
          kind: 'AuthorizationPolicy',
          metadata: {
            name: `tetris-api-auth-${c}`,
            namespace: ns,
          },
          spec: {
            targetRef: {
              group: 'policy.linkerd.io',
              kind: 'Server',
              name: `tetris-api-server-${c}`,
            },
            requiredAuthenticationRefs: allowedUsers.map(user => ({
              name: user,
              kind: 'ServiceAccount',
              group: '',
            })),
          },
        };

        // Apply Server (create or replace)
        try {
          await k8sRequest('POST',
            `/apis/policy.linkerd.io/v1beta3/namespaces/${ns}/servers`,
            server
          );
        } catch {
          await k8sRequest('PATCH',
            `/apis/policy.linkerd.io/v1beta3/namespaces/${ns}/servers/tetris-api-server-${c}`,
            server
          );
        }

        // Apply AuthorizationPolicy (create or replace)
        try {
          await k8sRequest('POST',
            `/apis/policy.linkerd.io/v1alpha1/namespaces/${ns}/authorizationpolicies`,
            authPolicy
          );
        } catch {
          await k8sRequest('PATCH',
            `/apis/policy.linkerd.io/v1alpha1/namespaces/${ns}/authorizationpolicies/tetris-api-auth-${c}`,
            authPolicy
          );
        }
      } catch (k8sErr) {
        console.error('k8s auth policy deploy failed:', k8sErr.message);
      }

      await pushLog(c, `Auth policy set: allow [${allowedUsers.join(', ')}]`);
    } else {
      // Remove k8s resources
      try {
        const creds = k8sCreds();
        const ns = creds.namespace;
        try {
          await k8sRequest('DELETE',
            `/apis/policy.linkerd.io/v1alpha1/namespaces/${ns}/authorizationpolicies/tetris-api-auth-${c}`
          );
        } catch { /* ignore if not found */ }
        try {
          await k8sRequest('DELETE',
            `/apis/policy.linkerd.io/v1beta3/namespaces/${ns}/servers/tetris-api-server-${c}`
          );
        } catch { /* ignore if not found */ }
      } catch (k8sErr) {
        console.error('k8s auth policy cleanup failed:', k8sErr.message);
      }

      await pushLog(c, 'Auth policy removed');
    }

    res.json({ auth_policy_enabled: enabled, allowed_users: allowedUsers });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/admin/toggle-egress', async (req, res) => {
  try {
    checkToken(req.body);
    const c = targetCluster(req.body);
    const cur = b(await redis.hget(k(c, 'game:state'), 'egress_enabled'));
    await redis.hset(k(c, 'game:state'), 'egress_enabled', cur ? '0' : '1');
    await pushLog(c, `Egress ${!cur ? 'enabled' : 'disabled'}`);
    res.json({ egress_enabled: !cur });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/admin/set-weights', async (req, res) => {
  try {
    checkToken(req.body);
    const c = targetCluster(req.body);
    const weights = req.body.weights || {};
    await redis.hset(k(c, 'game:state'), 'traffic_weights', JSON.stringify(weights));
    res.json({ weights });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/admin/reset', async (req, res) => {
  try {
    checkToken(req.body);
    const names = await clusterNames();
    const playerIds = await redis.smembers(gk('players'));
    if (playerIds.length) {
      const playerPipe = redis.pipeline();
      for (const pid of playerIds) playerPipe.del(gk(`player:${pid}`));
      playerPipe.del(gk('players'));
      await playerPipe.exec();
    }
    for (const c of names) {
      const pipe = redis.pipeline();
      pipe.hset(k(c, 'game:stats'), 'total_pieces_served', '0', 'total_requests', '0');
      pipe.del(k(c, 'game:piece_counts'));
      pipe.hset(k(c, 'game:state'), 'intercepted_count', '0', 'interceptor_active', '0');
      await pipe.exec();
    }
    res.json({ reset: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Dashboard API listening on port ${PORT}, Redis at ${REDIS_URL}`);
});
