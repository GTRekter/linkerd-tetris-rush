import { useState } from 'react';
import './ClusterCard.css';

const CLIENT_IDENTITIES = [
    { id: 'tetris-frontend', label: 'tetris-frontend' },
];

const ClusterCard = ({ entry, onSetLatency, onToggleMtls, onSetAuthPolicy, onScaleDown, onScaleUp }) => {
    const [selectedClients, setSelectedClients] = useState([]);

    const toggleClient = (id) => {
        setSelectedClients(prev =>
            prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
        );
    };

    const applyAuthPolicy = () => {
        onSetAuthPolicy(selectedClients);
    };

    const clearAuthPolicy = () => {
        setSelectedClients([]);
        onSetAuthPolicy([]);
    };

    return (
        <div className={`panel-card cluster-card-db ${entry.offline ? 'unhealthy' : entry.info.healthy ? 'healthy' : 'unhealthy'}`}>
            {/* Header */}
            <div className="d-flex align-items-center justify-content-between mb-2">
                <div className="d-flex align-items-center gap-2 fw-bold">
                    <span className="cluster-dot-db" style={{ background: entry.info.color }}></span>
                    {entry.info.cluster}
                    {entry.offline && (
                        <span className="badge bg-danger" style={{ fontSize: '0.65rem' }}>OFFLINE</span>
                    )}
                    {entry.auth_policy_enabled && (
                        <span style={{ fontSize: '0.85rem' }}>🛡️</span>
                    )}
                </div>
                {entry.offline ? (
                    <button className="btn btn-xs btn-outline-success" onClick={onScaleUp}>
                        Revive
                    </button>
                ) : (
                    <button className="btn btn-xs btn-outline-danger" onClick={onScaleDown}>
                        Kill
                    </button>
                )}
            </div>

            {/* Stats */}
            <div className="row g-2 text-center mb-2">
                <div className="col-3">
                    <div className="fs-6 fw-bold">{entry.stats.pieces}</div>
                    <div className="eyebrow">Pieces</div>
                </div>
                <div className="col-3">
                    <div className="fs-6 fw-bold">{entry.stats.players}</div>
                    <div className="eyebrow">Players</div>
                </div>
                <div className="col-3">
                    <div className="fs-6 fw-bold" style={{ color: entry.stats.rps > 5 ? '#22c55e' : undefined }}>
                        {(entry.stats.rps || 0).toFixed(1)}
                    </div>
                    <div className="eyebrow">RPS</div>
                </div>
                <div className="col-3">
                    <div className="fs-6 fw-bold" style={{ color: entry.stats.denied > 0 ? '#ef4444' : undefined }}>
                        {entry.stats.denied || 0}
                    </div>
                    <div className="eyebrow">Denied</div>
                </div>
            </div>

            {/* Latency */}
            {!entry.offline && (
                <div className="card-section">
                    <div className="eyebrow mb-1">Latency</div>
                    <div className="d-flex align-items-center gap-1 small text-white-50">
                        <input
                            type="range" min="0" max="3000" step="100"
                            value={entry.stats.latency_ms || 0}
                            onChange={e => onSetLatency(e.target.value)}
                            className="form-range flex-grow-1"
                            style={{ accentColor: '#f59e0b' }}
                        />
                        <span style={{ minWidth: 40 }}>{entry.stats.latency_ms || 0}ms</span>
                    </div>
                </div>
            )}

            {/* mTLS */}
            {!entry.offline && (
                <div className="card-section">
                    <div className="eyebrow mb-1">Encryption</div>
                    <div className="d-flex gap-2 flex-wrap align-items-center">
                        <button
                            className={`btn btn-xs ${entry.mtls_enabled ? 'btn-outline-warning' : 'btn-outline-success'}`}
                            onClick={onToggleMtls}
                        >
                            {entry.mtls_enabled ? 'Disable mTLS' : 'Enable mTLS'}
                        </button>
                        {entry.interceptor_active && (
                            <span className="badge bg-danger align-self-center" style={{ fontSize: '0.65rem' }}>
                                MITM Interceptor ON ({entry.intercepted_count})
                            </span>
                        )}
                    </div>
                </div>
            )}

            {/* AuthorizationPolicy */}
            {!entry.offline && (
                <div className="card-section">
                    <div className="eyebrow mb-1">Authorization Policy</div>
                    <div className="user-select-list mb-2">
                        {CLIENT_IDENTITIES.map(c => (
                            <button
                                key={c.id}
                                className={`user-chip ${selectedClients.includes(c.id) ? 'selected' : ''}`}
                                onClick={() => toggleClient(c.id)}
                            >
                                {c.label}
                            </button>
                        ))}
                    </div>
                    <div className="d-flex gap-2">
                        <button
                            className="btn btn-xs btn-outline-info"
                            onClick={applyAuthPolicy}
                            disabled={selectedClients.length === 0}
                        >
                            Apply Policy ({selectedClients.length})
                        </button>
                        {entry.auth_policy_enabled && (
                            <button
                                className="btn btn-xs btn-outline-warning"
                                onClick={clearAuthPolicy}
                            >
                                Remove Policy
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default ClusterCard;
