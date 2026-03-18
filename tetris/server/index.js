const express = require('express');
const path = require('path');
const http = require('http');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 80;
const API_TARGET = process.env.API_TARGET || 'http://127.0.0.1:8000';
const staticDir = path.resolve(__dirname, './build');

// Proxy /api/* to tetris-api (federated via Linkerd).
app.all('/api/*', (req, res) => {
  const target = new URL(API_TARGET);
  const opts = {
    hostname: target.hostname,
    port: target.port || 80,
    path: req.originalUrl,
    method: req.method,
    headers: { ...req.headers, host: target.host },
  };

  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
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
  console.log(`Frontend server listening on port ${PORT}, proxying /api to ${API_TARGET}`);
});
