import { PIECE_COLORS } from '../constants/pieces';

const PieceHistogram = ({ clusters }) => {
    const counts = {};
    for (const [, entry] of Object.entries(clusters)) {
        const pc = entry.piece_type_counts || {};
        for (const [type, n] of Object.entries(pc)) {
            counts[type] = (counts[type] || 0) + n;
        }
    }
    const total = Object.values(counts).reduce((s, n) => s + n, 0) || 1;

    return (
        <div className="panel-card">
            <p className="eyebrow">Piece Distribution (60s)</p>
            {Object.entries(PIECE_COLORS).map(([type, color]) => (
                <div key={type} className="d-flex align-items-center gap-2 mb-3" style={{ fontSize: '0.78rem' }}>
                    <span style={{ color, fontWeight: 700, width: 14 }}>{type}</span>
                    <div className="flex-grow-1 progress" style={{ height: 6, background: 'rgba(255,255,255,0.06)' }}>
                        <div
                            className="progress-bar"
                            style={{ width: `${((counts[type] || 0) / total) * 100}%`, background: color }}
                        />
                    </div>
                    <span className="text-white-50" style={{ width: 24, textAlign: 'right' }}>{counts[type] || 0}</span>
                </div>
            ))}
        </div>
    );
};

export default PieceHistogram;
