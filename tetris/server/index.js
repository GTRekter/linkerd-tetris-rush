const express = require('express');
const path = require('path');
const http = require('http');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 80;
const API_TARGET = process.env.API_TARGET || 'http://127.0.0.1:8000';
const API_TARGET_FEDERATED = process.env.API_TARGET_FEDERATED || API_TARGET.replace('game-api', 'game-api-federated');
const AGENT_URL = process.env.AGENT_URL || '';
const staticDir = path.resolve(__dirname, './build');

// Fire-and-forget: tell the agent about a Linkerd-level denial
function reportDenied() {
  if (!AGENT_URL) return;
  const u = new URL(AGENT_URL);
  const payload = JSON.stringify({});
  const opts = {
    hostname: u.hostname,
    port: u.port || 80,
    path: '/api/internal/report-denied',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    timeout: 2000,
  };
  const req = http.request(opts);
  req.on('error', () => {});
  req.write(payload);
  req.end();
}

// Current multicluster mode and mTLS state — polled from the local game-api
let currentMode = 'federated';
let mtlsEnabled = true;

function activeTarget() {
  // When mTLS is disabled the pod is unmeshed so federated/mirrored services
  // are unreachable — always route to the local game-api.
  if (!mtlsEnabled) return API_TARGET;
  return currentMode === 'federated' ? API_TARGET_FEDERATED : API_TARGET;
}

// Poll /api/info on the local game-api to track the current mode
function pollMode() {
  const local = new URL(API_TARGET);
  const opts = {
    hostname: local.hostname,
    port: local.port || 80,
    path: '/api/info',
    method: 'GET',
    timeout: 3000,
  };

  const req = http.request(opts, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.multicluster_mode) {
          currentMode = data.multicluster_mode;
        }
        if (data.mtls_enabled !== undefined) {
          mtlsEnabled = data.mtls_enabled !== false;
        }
      } catch { /* ignore parse errors */ }
    });
  });
  req.on('error', () => { /* local api not ready yet */ });
  req.end();
}

// Start polling once the server is up
setInterval(pollMode, 3000);
setTimeout(pollMode, 1000);

// Proxy /api/* to game-api or game-api-federated based on current mode.
app.all('/api/*', (req, res) => {
  const target = new URL(activeTarget());
  const opts = {
    hostname: target.hostname,
    port: target.port || 80,
    path: req.originalUrl,
    method: req.method,
    headers: { ...req.headers, host: target.host },
  };

  const proxyReq = http.request(opts, (proxyRes) => {
    if (proxyRes.statusCode === 403) {
      reportDenied();
    }
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    reportDenied();
    res.status(502).json({ error: 'bad_gateway' });
  });

  req.pipe(proxyReq);
});

// Serve React build
app.use(express.static(staticDir));

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Frontend server listening on port ${PORT}`);
  console.log(`  API_TARGET (gateway/mirrored): ${API_TARGET}`);
  console.log(`  API_TARGET_FEDERATED:          ${API_TARGET_FEDERATED}`);
});
