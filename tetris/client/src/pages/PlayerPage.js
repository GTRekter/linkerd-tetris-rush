import { useState, useRef } from 'react';
import { useGame } from '../hooks/useGame';
import { joinGame as apiJoin } from '../services/gameApi';
import JoinScreen from '../components/JoinScreen';
import GameBoard from '../components/GameBoard';
import ScoreSidebar from '../components/ScoreSidebar';
import PieceSidebar from '../components/PieceSidebar';
import GameOverScreen from '../components/GameOverScreen';
import { BOARD_W, BOARD_H } from '../services/gameEngine';
import './playerPage.css';

/* ── Preview mode ────────────────────────────────────────────────────────── */
const PREVIEW = new URLSearchParams(window.location.search).has('preview');

function buildMockBoard() {
    const b = Array.from({ length: BOARD_H }, () => Array(BOARD_W).fill(null));
    // Scatter some locked pieces at the bottom rows
    const colors = [
        { color: '#06b6d4', clusterColor: '#22c55e', cluster: 'gameplay-central', corrupted: false },
        { color: '#a855f8', clusterColor: '#3b82f6', cluster: 'gameplay-east',    corrupted: false },
        { color: '#f97316', clusterColor: '#eab308', cluster: 'gameplay-west',    corrupted: false },
        { color: '#ef4444', clusterColor: '#ef4444', cluster: 'gameplay-central', corrupted: false },
    ];
    for (let y = 17; y < 20; y++) {
        for (let x = 0; x < BOARD_W; x++) {
            if (Math.random() < 0.5) b[y][x] = colors[Math.floor(Math.random() * colors.length)];
        }
    }
    return b;
}

const MOCK = PREVIEW ? {
    board: buildMockBoard(),
    currentPiece: {
        type: 'T', matrix: [[0,1,0],[1,1,1]], x: 4, y: 3,
        color: '#a855f8', clusterColor: '#22c55e', cluster: 'gameplay-central', corrupted: false,
    },
    score: 2400, lines: 18, level: 3,
    scenario: 'httproute', mtlsEnabled: true, authPolicyEnabled: false,
    statusMsg: null, waitingForPiece: false, retryCount: 0,
    nextPieceMeta: { piece: 'S', cluster: 'gameplay-west', clusterColor: '#22c55e', latency: 12, mtls: true, corrupted: false },
    feed: [
        { id: 1, cluster: 'gameplay-central', clusterColor: '#22c55e', piece: 'T', latency: 8, corrupted: false, denied: false },
        { id: 2, cluster: 'gameplay-east',    clusterColor: '#3b82f6', piece: 'I', latency: 14, corrupted: false, denied: false },
    ],
    leaderboard: null,
} : null;

/* ── Component ───────────────────────────────────────────────────────────── */

const PlayerPage = () => {
    const [playerName, setPlayerName] = useState('');
    const mockBoardRef = useRef(PREVIEW ? MOCK.board : null);

    const game = useGame();

    const joinGame = async () => {
        const name = playerName.trim() || 'Anonymous';
        try {
            const data = await apiJoin(name);
            setPlayerName(name);
            game.onJoined(data.player_id);
        } catch {
            // status shown by game hook on WS errors; nothing to do here
        }
    };

    /* In preview mode skip join & game-over screens */
    if (!PREVIEW) {
        if (!game.joined) {
            return (
                <div className="player-bg">
                    <JoinScreen
                        playerName={playerName}
                        onNameChange={setPlayerName}
                        onJoin={joinGame}
                    />
                </div>
            );
        }

        if (game.gameOver) {
            return (
                <div className="player-bg">
                    <GameOverScreen
                        playerName={playerName}
                        score={game.score}
                        lines={game.lines}
                        level={game.level}
                        onPlayAgain={game.startNewGame}
                        leaderboard={game.leaderboard}
                        onToggleLeaderboard={game.toggleLeaderboard}
                    />
                </div>
            );
        }
    }

    /* Pick real or mock data */
    const g = PREVIEW ? MOCK : game;
    const boardRef = PREVIEW ? mockBoardRef : game.boardRef;

    return (
        <div
            className="player-bg tetris-page"
            onTouchStart={game.onTouchStart}
            onTouchMove={game.onTouchMove}
            onTouchEnd={game.onTouchEnd}
            style={{ touchAction: 'none', userSelect: 'none' }}
        >
            <div className="container-fluid h-100">
                <div className="row h-100 align-items-center justify-content-center tetris-row">
                    <div className="col-auto d-none d-md-block tetris-col-sidebar">
                        <ScoreSidebar
                            score={g.score}
                            lines={g.lines}
                            level={g.level}
                            scenario={g.scenario}
                            mtlsEnabled={g.mtlsEnabled}
                            authPolicyEnabled={g.authPolicyEnabled}
                            leaderboard={g.leaderboard}
                            onToggleLeaderboard={game.toggleLeaderboard}
                        />
                    </div>

                    <div className="col-12 col-md-auto d-flex justify-content-center">
                        <GameBoard
                            board={g.board}
                            currentPiece={g.currentPiece}
                            boardRef={boardRef}
                            statusMsg={g.statusMsg}
                            waitingForPiece={g.waitingForPiece}
                            retryCount={g.retryCount}
                        />
                    </div>

                    {/* Desktop: full sidebar */}
                    <div className="col-auto d-none d-md-block tetris-col-sidebar">
                        <PieceSidebar
                            lastPieceMeta={g.nextPieceMeta}
                            feed={g.feed}
                        />
                    </div>
                </div>

                {/* Mobile: compact piece bar at the bottom */}
                <div className="d-md-none tetris-mobile-bottom">
                    <PieceSidebar
                        lastPieceMeta={g.nextPieceMeta}
                        feed={g.feed}
                        compact
                    />
                </div>
            </div>
        </div>
    );
};

export default PlayerPage;
