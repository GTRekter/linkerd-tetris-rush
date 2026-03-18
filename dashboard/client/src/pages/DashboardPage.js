import { useState, useRef, useEffect, useCallback } from 'react';
import {
    fetchClusters, fetchClusterInfo, fetchClusterLogs, fetchClusterPieces,
    fetchClusterUsers, fetchClusterLatency, fetchLeaderboard,
    adminPost,
} from '../services/dashboardApi.js';
import GlobalStats from '../components/GlobalStats';
import ModeSelector from '../components/ScenarioTabs';
import ClusterCard from '../components/ClusterCard';
import TrafficCanvas from '../components/TrafficCanvas';
import LeaderboardPanel from '../components/LeaderboardPanel';
import QRCodeSidebar from '../components/QRCodeSidebar';
import PieceHistogram from '../components/PieceHistogram';
import EventLog from '../components/EventLog';
import './dashboardPage.css';

const POLL_INTERVAL_MS = 1000;

const DashboardPage = () => {
    const [multiclusterMode, setMulticlusterMode] = useState('federated');
    const [clusters, setClusters] = useState({});
    const [eventLog, setEventLog] = useState([]);
    const [leaderboard, setLeaderboard] = useState([]);

    const particlesRef = useRef([]);
    const allRequestsRef = useRef([]);
    const canvasRef = useRef(null);
    const timerRef = useRef(null);

    const addLog = useCallback((cluster, color, text) => {
        const now = new Date().toLocaleTimeString('en-US', { hour12: false });
        setEventLog(prev => [{ time: now, cluster, color, text, id: Date.now() + Math.random() }, ...prev].slice(0, 200));
    }, []);

    const addParticle = useCallback((color) => {
        if (!particlesRef.current) return;
        const canvas = canvasRef.current;
        const w = canvas ? canvas.width : 600;
        const h = canvas ? canvas.height : 200;
        particlesRef.current.push({
            x: Math.random() * w * 0.25,
            y: h / 2 + (Math.random() - 0.5) * h * 0.7,
            targetX: w * 0.5 + Math.random() * w * 0.4,
            targetY: h / 2 + (Math.random() - 0.5) * h * 0.5,
            color,
            progress: 0,
            speed: 0.014 + Math.random() * 0.018,
            size: 3 + Math.random() * 3,
        });
    }, []);

    const poll = useCallback(async () => {
        try {
            const clusterList = await fetchClusters();
            const results = await Promise.all(
                clusterList.map(async (c) => {
                    const name = c.name;
                    const [info, logs, pieces, users, latency] = await Promise.all([
                        fetchClusterInfo(name),
                        fetchClusterLogs(name),
                        fetchClusterPieces(name),
                        fetchClusterUsers(name),
                        fetchClusterLatency(name),
                    ]);
                    return { name, clusterMeta: c, info, logs, pieces, users, latency };
                })
            );

            setClusters(prev => {
                const next = { ...prev };
                for (const { name, clusterMeta, info, pieces, users, latency } of results) {
                    const existing = prev[name] || {};
                    const prevPieces = existing.stats?.pieces || 0;
                    const newPieces = pieces.total_pieces_served || 0;
                    const delta = Math.max(0, newPieces - prevPieces);
                    const requestTimes = [...(existing.requestTimes || [])];
                    for (let i = 0; i < delta; i++) requestTimes.push(Date.now());
                    const cutoff = Date.now() - 10000;
                    const filtered = requestTimes.filter(t => t > cutoff);
                    if (delta > 0) {
                        addParticle(clusterMeta.color);
                        allRequestsRef.current.push({
                            cluster: name,
                            cluster_color: clusterMeta.color,
                            receivedAt: Date.now(),
                        });
                        if (allRequestsRef.current.length > 500) allRequestsRef.current.splice(0, 100);
                    }
                    const wasHealthy = existing.info?.healthy;
                    const wasOffline = existing.offline !== false;
                    if (wasOffline && info.healthy) {
                        addLog(name, '#64748b', `Connected to ${name}`);
                    }
                    if (!wasOffline && wasHealthy && !info.healthy) {
                        addLog(name, '#ef4444', 'DOWN — failover active!');
                    } else if (!wasOffline && !wasHealthy && info.healthy) {
                        addLog(name, '#22c55e', 'RECOVERED — traffic resuming');
                    }
                    if (info.multicluster_mode) setMulticlusterMode(info.multicluster_mode);
                    next[name] = {
                        baseUrl: window.location.origin,
                        clusterName: name,
                        offline: !info.healthy,
                        info: {
                            cluster: info.cluster,
                            color: clusterMeta.color,
                            region: info.region,
                            healthy: info.healthy,
                        },
                        stats: {
                            pieces: newPieces,
                            players: users.player_count || 0,
                            latency_ms: latency.artificial_latency_ms || 0,
                            rps: +(filtered.length / 10).toFixed(1),
                            denied: existing.stats?.denied || 0,
                            corrupted: existing.stats?.corrupted || 0,
                        },
                        requestTimes: filtered,
                        mtls_enabled: info.mtls_enabled,
                        interceptor_active: info.interceptor_active || false,
                        intercepted_count: info.intercepted_count || 0,
                        auth_policy_enabled: info.auth_policy_enabled || false,
                        traffic_weights: info.traffic_weights || {},
                        piece_type_counts: pieces.piece_type_counts || {},
                    };
                }
                return next;
            });
        } catch {
            setClusters(prev => {
                const next = {};
                for (const [name, data] of Object.entries(prev)) {
                    const wasOnline = !data.offline;
                    if (wasOnline) {
                        addLog('system', '#ef4444', 'Lost connection to dashboard API');
                    }
                    next[name] = { ...data, offline: true, info: { ...data.info, healthy: false } };
                }
                return next;
            });
        }
    }, [addLog, addParticle]);

    const loadLeaderboard = useCallback(async () => {
        try {
            const data = await fetchLeaderboard();
            setLeaderboard(data);
        } catch {
            setLeaderboard([]);
            addLog('system', '#ef4444', 'Failed to load leaderboard');
        }
    }, []);

    useEffect(() => {
        poll();
        loadLeaderboard();
        timerRef.current = setInterval(() => {
            poll();
            loadLeaderboard();
        }, POLL_INTERVAL_MS);
        return () => clearInterval(timerRef.current);
    }, [poll, loadLeaderboard]);

    const requestWithLog = useCallback(async (apiFunction, label) => {
        try {
            await apiFunction();
            addLog('system', '#22c55e', `${label} succeeded`);
        } catch {
            addLog('system', '#ef4444', `Failed: ${label}`);
        }
    }, [addLog]);

    const handleModeChange = useCallback((mode) => {
        requestWithLog(() => adminPost('/api/admin/set-mode', { mode }), `set-mode → ${mode}`);
        setMulticlusterMode(mode);
    }, [requestWithLog]);

    const handleScaleDown = useCallback((cluster) => requestWithLog(() => adminPost('/admin/scale-down', { cluster }), 'scale-down'), [requestWithLog]);
    const handleScaleUp = useCallback((cluster) => requestWithLog(() => adminPost('/admin/scale-up', { cluster }), 'scale-up'), [requestWithLog]);
    const handleSetLatency = useCallback((cluster, ms) => requestWithLog(() => adminPost('/api/admin/set-latency', { cluster, latency_ms: parseInt(ms) }), 'set-latency'), [requestWithLog]);
    const handleToggleMtls = useCallback((cluster) => requestWithLog(() => adminPost('/api/admin/toggle-mtls', { cluster }), 'toggle-mtls'), [requestWithLog]);
    const handleSetAuthPolicy = useCallback((cluster, allowedUsers) => {
        requestWithLog(
            () => adminPost('/api/admin/set-auth-policy', { cluster, allowed_users: allowedUsers }),
            allowedUsers.length > 0
                ? `auth-policy → allow [${allowedUsers.join(', ')}]`
                : 'auth-policy → removed'
        );
    }, [requestWithLog]);

    // Computed stats
    const clusterEntries = Object.entries(clusters);
    let totalPlayers = 0, totalPieces = 0, totalDenied = 0;
    for (const [, e] of clusterEntries) {
        totalPlayers += e.stats.players || 0;
        totalPieces += e.stats.pieces || 0;
        totalDenied += e.stats.denied || 0;
    }
    const activeClusters = clusterEntries.filter(([, c]) => !c.offline && c.info.healthy).length;
    const cutoff = Date.now() - 5000;
    const rps = (allRequestsRef.current.filter(r => r.receivedAt > cutoff).length / 5).toFixed(1);

    return (
        <div className="full-height-container text-white dashboard-page">
            <div className="container-fluid">

                <div className="row g-3 mb-3">
                    <div className="col-12">
                        <div className="d-flex align-items-center gap-3 flex-wrap">
                            <GlobalStats
                                totalPlayers={totalPlayers}
                                totalPieces={totalPieces}
                                activeClusters={activeClusters}
                                totalClusters={clusterEntries.length}
                                rps={rps}
                                totalDenied={totalDenied}
                            />
                        </div>
                    </div>
                    <div className="col-12">
                        <div className="d-flex align-items-center gap-3 flex-wrap">
                            <ModeSelector
                                currentMode={multiclusterMode}
                                onModeChange={handleModeChange}
                            />
                        </div>
                    </div>
                </div>

                <div className="row g-3 mb-3">
                    <div className="col-12 col-lg-8">
                        <LeaderboardPanel leaderboard={leaderboard} />
                    </div>
                    <div className="col-12 col-lg-4">
                        <QRCodeSidebar origin={window.location.origin} />
                    </div>
                </div>

                <div className="row g-3 mb-3">
                    {clusterEntries.map(([name, entry]) => (
                        <div className="col-12 col-md-6 col-xl-4" key={name}>
                            <ClusterCard
                                entry={entry}
                                onScaleDown={() => handleScaleDown(name)}
                                onScaleUp={() => handleScaleUp(name)}
                                onSetLatency={(ms) => handleSetLatency(name, ms)}
                                onToggleMtls={() => handleToggleMtls(name)}
                                onSetAuthPolicy={(clients) => handleSetAuthPolicy(name, clients)}
                            />
                        </div>
                    ))}
                </div>

                <div className="row g-3 mb-3">
                    <div className="col-12 col-lg-8">
                        <TrafficCanvas
                            clusters={clusters}
                            particlesRef={particlesRef}
                            canvasRef={canvasRef}
                        />
                    </div>
                    <div className="col-12 col-lg-4">
                        <PieceHistogram clusters={clusters} />
                    </div>
                </div>

                <div className="row g-3">
                    <div className="col-12">
                        <EventLog eventLog={eventLog} />
                    </div>
                </div>

            </div>
        </div>
    );
};

export default DashboardPage;
