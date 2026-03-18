const LeaderboardPanel = ({ leaderboard }) => (
    <div className="panel-card" style={{ height: '100%' }}>
        <p className="eyebrow mb-2">Leaderboard</p>
        {leaderboard.length === 0 ? (
            <p className="text-white-50 small mb-0">No scores yet</p>
        ) : (
            leaderboard.slice(0, 10).map((p, i) => (
                <div
                    key={i}
                    className="d-flex align-items-center py-1"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: '0.82rem' }}
                >
                    <span className="text-white-50 me-2" style={{ width: 24 }}>
                        {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
                    </span>
                    <span className="flex-grow-1">{p.name}</span>
                    <span className="text-white-50 small me-2">L{p.level}</span>
                    <span className="fw-bold" style={{ color: '#638cff' }}>{p.score}</span>
                </div>
            ))
        )}
    </div>
);

export default LeaderboardPanel;
