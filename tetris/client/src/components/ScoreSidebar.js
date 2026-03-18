const ScoreSidebar = ({
    score, lines, level,
    scenario, mtlsEnabled, authPolicyEnabled, egressEnabled,
    leaderboard, onToggleLeaderboard,
}) => (
    <div className="tetris-sidebar-left">
        <div className="panel-card text-center py-2 mb-2">
            <div className="fs-3 fw-bold" style={{ color: '#638cff' }}>{score}</div>
            <div className="eyebrow">Score</div>
        </div>
        <div className="panel-card text-center py-2 mb-2">
            <div className="fs-5 fw-bold">{lines}</div>
            <div className="eyebrow">Lines</div>
        </div>
        <div className="panel-card text-center py-2 mb-2">
            <div className="fs-5 fw-bold">{level}</div>
            <div className="eyebrow">Level</div>
        </div>

        <div className="scenario-badge-pill mb-2">
            {scenario === 'mtls' && (
                <span className={`mtls-pill ${mtlsEnabled ? 'secure' : 'insecure'}`}>
                    {mtlsEnabled ? '🔒' : '🔓'}
                </span>
            )}
            {scenario === 'auth-policy' && authPolicyEnabled && (
                <span className="auth-pill">🛡️</span>
            )}
            {scenario === 'egress' && egressEnabled && (
                <span className="egress-pill">🌐</span>
            )}
        </div>

        <button className="btn btn-sm btn-outline-secondary w-100 mb-2" onClick={onToggleLeaderboard}>
            {leaderboard ? 'Close' : '🏆'}
        </button>

        {leaderboard && (
            <div className="panel-card" style={{ fontSize: '0.7rem' }}>
                {leaderboard.slice(0, 8).map((p, i) => (
                    <div key={i} className="d-flex py-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <span className="text-white-50 me-1" style={{ width: 16 }}>{i + 1}</span>
                        <span className="flex-grow-1 text-truncate">{p.name}</span>
                        <span style={{ color: '#638cff' }}>{p.score}</span>
                    </div>
                ))}
            </div>
        )}
    </div>
);

export default ScoreSidebar;
