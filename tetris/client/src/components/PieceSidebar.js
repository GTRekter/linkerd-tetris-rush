import { PIECE_COLORS } from '../constants/pieces';
import './PieceSidebar.css';

const PieceSidebar = ({ lastPieceMeta, feed }) => (
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
                    {lastPieceMeta.egress && (
                        <span className="badge bg-info text-dark" style={{ fontSize: '0.6rem' }}>EGRESS</span>
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
                        {item.egress && <span style={{ fontSize: '0.6rem' }}>&#x1F310;</span>}
                        <span className="ms-auto text-white-50" style={{ fontSize: '0.65rem' }}>
                            {item.denied ? '' : `${item.latency}ms`}
                        </span>
                    </div>
                </div>
            ))}
        </div>
    </div>
);

export default PieceSidebar;
