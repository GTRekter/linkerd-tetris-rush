import { PIECE_COLORS } from '../constants/pieces';
import './PieceSidebar.css';

/* ── Compact inline bar (mobile) ──────────────────────────────────────────── */

const CompactPieceSidebar = ({ lastPieceMeta, feed }) => {
    const visibleFeed = feed.slice(0, 2);

    return (
        <div className="compact-piece-bar">
            {/* Next piece */}
            {lastPieceMeta && (
                <span className="compact-piece-next">
                    <span className="compact-label">NEXT</span>
                    <span
                        className="compact-piece-letter"
                        style={{ color: PIECE_COLORS[lastPieceMeta.piece] || '#fff' }}
                    >
                        {lastPieceMeta.piece}
                    </span>
                    <span
                        className="badge rounded-pill compact-cluster"
                        style={{ background: lastPieceMeta.clusterColor || '#555' }}
                    >
                        {lastPieceMeta.cluster}
                    </span>
                    <span className="compact-latency">{lastPieceMeta.latency}ms</span>
                    {lastPieceMeta.corrupted && (
                        <span className="compact-badge-danger">!</span>
                    )}
                    {lastPieceMeta.mtls === false && (
                        <span className="compact-badge-warn">mTLS</span>
                    )}
                </span>
            )}

            {/* Separator */}
            {visibleFeed.length > 0 && <span className="compact-sep" />}

            {/* Last 2 feed items */}
            {visibleFeed.map(item => (
                <span
                    key={item.id}
                    className={`compact-feed-item ${item.denied ? 'compact-denied' : ''}`}
                >
                    <span
                        className="badge rounded-pill compact-cluster"
                        style={{ background: item.clusterColor || '#555' }}
                    >
                        {item.cluster}
                    </span>
                    {item.denied
                        ? <span className="compact-denied-text">DENIED</span>
                        : <span style={{ color: PIECE_COLORS[item.piece], fontWeight: 700 }}>{item.piece}</span>
                    }
                    {item.corrupted && <span className="compact-warn-icon">&#x26A0;</span>}
                    {!item.denied && <span className="compact-latency">{item.latency}ms</span>}
                </span>
            ))}
        </div>
    );
};

/* ── Full sidebar (desktop) ──────────────────────────────────────────────── */

const PieceSidebar = ({ lastPieceMeta, feed, compact }) => {
    if (compact) {
        return <CompactPieceSidebar lastPieceMeta={lastPieceMeta} feed={feed} />;
    }

    return (
        <div className="tetris-sidebar-right">
            {lastPieceMeta && (
                <div className="panel-card mb-2 last-piece-card">
                    <div className="eyebrow mb-1">Next piece</div>
                    <div className="d-flex align-items-center gap-2 mb-1">
                        <span
                            className="piece-type-badge"
                            style={{ color: PIECE_COLORS[lastPieceMeta.piece] || '#fff' }}
                        >
                            {lastPieceMeta.piece}
                        </span>
                        {lastPieceMeta.corrupted && (
                            <span className="badge bg-danger" style={{ fontSize: '0.6rem' }}>TAMPERED</span>
                        )}
                    </div>
                    <div style={{ fontSize: '0.72rem' }}>
                        <span
                            className="badge rounded-pill text-white"
                            style={{ background: lastPieceMeta.clusterColor || '#555', fontSize: '0.65rem' }}
                        >
                            {lastPieceMeta.cluster}
                        </span>
                    </div>
                    <div className="text-white-50 mt-1" style={{ fontSize: '0.7rem' }}>
                        {lastPieceMeta.latency}ms
                        {lastPieceMeta.mtls === false && (
                            <span className="badge bg-warning text-dark ms-1" style={{ fontSize: '0.6rem' }}>NO mTLS</span>
                        )}
                    </div>
                </div>
            )}

            <div className="tetris-feed">
                {feed.map(item => (
                    <div
                        key={item.id}
                        className={`feed-item panel-card py-1 px-2 mb-1 ${item.denied ? 'feed-error' : ''} ${item.corrupted ? 'feed-intercepted' : ''}`}
                        style={{ borderLeft: `3px solid ${item.clusterColor || '#555'}` }}
                    >
                        <div className="d-flex align-items-center gap-1">
                            <span
                                className="badge rounded-pill text-white"
                                style={{ background: item.clusterColor || '#555', fontSize: '0.6rem' }}
                            >
                                {item.cluster}
                            </span>
                            {item.denied
                                ? <span className="text-danger" style={{ fontSize: '0.7rem' }}>DENIED</span>
                                : <span style={{ color: PIECE_COLORS[item.piece], fontSize: '0.75rem', fontWeight: 700 }}>{item.piece}</span>
                            }
                            {item.corrupted && <span style={{ fontSize: '0.6rem' }}>&#x26A0;</span>}
                            <span className="ms-auto text-white-50" style={{ fontSize: '0.65rem' }}>
                                {item.denied ? '' : `${item.latency}ms`}
                            </span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default PieceSidebar;
