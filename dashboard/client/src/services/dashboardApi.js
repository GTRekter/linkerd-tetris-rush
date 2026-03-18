const ADMIN_TOKEN = 'demo-admin-2024';

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
}

export const fetchClusters = () => fetchJson('/api/clusters');
export const fetchClusterInfo = (name) => fetchJson(`/api/clusters/${name}/info`);
export const fetchClusterLogs = (name) => fetchJson(`/api/clusters/${name}/logs`);
export const fetchClusterPieces = (name) => fetchJson(`/api/clusters/${name}/pieces`);
export const fetchClusterUsers = (name) => fetchJson(`/api/clusters/${name}/users`);
export const fetchClusterLatency = (name) => fetchJson(`/api/clusters/${name}/latency`);

export async function fetchInfoAll() {
    const res = await fetch('/api/info-all');
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
}

export async function fetchLeaderboard() {
    const res = await fetch('/api/leaderboard');
    return res.json();
}

export async function adminPost(path, body = {}) {
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: ADMIN_TOKEN, ...body }),
    });
    return res;
}

export const setLatency = (cluster, latency_ms) => adminPost('/api/admin/set-latency', { cluster, latency_ms: parseInt(latency_ms) });
export const toggleMtls = (cluster) => adminPost('/api/admin/toggle-mtls', { cluster });
export const setAuthPolicy = (cluster, allowed_users) => adminPost('/api/admin/set-auth-policy', { cluster, allowed_users });
export const setMode = (mode) => adminPost('/api/admin/set-mode', { mode });
export const resetCluster = () => adminPost('/api/admin/reset');
