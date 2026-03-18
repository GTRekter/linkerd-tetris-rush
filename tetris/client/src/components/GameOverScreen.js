const GameOverScreen = ({ playerName, score, lines, level, onPlayAgain, leaderboard, onToggleLeaderboard }) => (
    <div className="full-height-container text-white d-flex align-items-center">
        <div className="container">
            <div className="row justify-content-center">
                <div className="col-12 col-md-5 col-lg-4 text-center py-4">
                    <div className="panel-card">
                        <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>&#x1F480;</div>
                        <h2 className="gradient-title mb-1">Game Over</h2>
                        <p className="text-white-50 mb-3">{playerName}</p>
                        <div className="row g-2 mb-4">
                            <div className="col-4">
                                <div className="panel-card py-2 text-center">
                                    <div className="fs-4 fw-bold" style={{ color: '#638cff' }}>{score}</div>
                                    <div className="eyebrow">Score</div>
                                </div>
                            </div>
                            <div className="col-4">
                                <div className="panel-card py-2 text-center">
                                    <div className="fs-4 fw-bold">{lines}</div>
                                    <div className="eyebrow">Lines</div>
                                </div>
                            </div>
                            <div className="col-4">
                                <div className="panel-card py-2 text-center">
                                    <div className="fs-4 fw-bold">{level}</div>
                                    <div className="eyebrow">Level</div>
                                </div>
                            </div>
                        </div>
                        <button className="btn btn-primary w-100 fw-bold mb-2" onClick={onPlayAgain}>
                            Play Again
                        </button>
                        <button className="btn btn-outline-secondary w-100 btn-sm" onClick={onToggleLeaderboard}>
                            {leaderboard ? 'Hide Leaderboard' : 'View Leaderboard'}
                        </button>
                        {leaderboard && (
                            <div className="mt-3">
                                {leaderboard.map((p, i) => (
                                    <div
                                        key={i}
                                        className="d-flex align-items-center py-1"
                                        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: '0.85rem' }}
                                    >
                                        <span className="text-white-50 me-2" style={{ width: 24 }}>
                                            {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
                                        </span>
                                        <span className="flex-grow-1">{p.name}</span>
                                        <span className="fw-bold" style={{ color: '#638cff' }}>{p.score}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    </div>
);

export default GameOverScreen;
