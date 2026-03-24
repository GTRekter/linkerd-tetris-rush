const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 80;
const DASHBOARD_API_TARGET = process.env.DASHBOARD_API_TARGET || 'http://127.0.0.1:8001';
const staticDir = path.resolve(__dirname, './build');

// Proxy /go to dashboard-api (round-robin player redirect).
app.use(createProxyMiddleware({
  target: DASHBOARD_API_TARGET,
  changeOrigin: true,
  pathFilter: '/go',
}));

// Proxy /admin/* to dashboard-api (k8s scaling).
app.use(createProxyMiddleware({
  target: DASHBOARD_API_TARGET,
  changeOrigin: true,
  pathFilter: '/admin',
}));

// Proxy /api/* to dashboard-api (cluster config, admin commands to game-api).
app.use(createProxyMiddleware({
  target: DASHBOARD_API_TARGET,
  changeOrigin: true,
  pathFilter: '/api',
}));

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
  console.log(`Dashboard server listening on port ${PORT}, proxying to dashboard-api at ${DASHBOARD_API_TARGET}`);
});
