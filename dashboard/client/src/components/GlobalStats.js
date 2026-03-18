const GlobalStats = ({ totalPlayers, totalPieces, activeClusters, totalClusters, rps, totalDenied }) => (
    <div className="d-flex gap-4 small">
        <span><span className="status-dot bg-success me-1"></span>Players: <strong>{totalPlayers}</strong></span>
        <span><span className="status-dot bg-primary me-1"></span>Pieces: <strong>{totalPieces}</strong></span>
        <span><span className="status-dot bg-warning me-1"></span>Clusters: <strong>{activeClusters}/{totalClusters}</strong></span>
        <span className="text-white-50">RPS: <strong style={{ color: '#638cff' }}>{rps}</strong></span>
        {totalDenied > 0 && (
            <span className="text-danger">Denied: <strong>{totalDenied}</strong></span>
        )}
    </div>
);

export default GlobalStats;
