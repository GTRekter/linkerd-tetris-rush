import { useState } from 'react';
import { useGame } from '../hooks/useGame';
import { joinGame as apiJoin } from '../services/gameApi';
import JoinScreen from '../components/JoinScreen';
import GameBoard from '../components/GameBoard';
import ScoreSidebar from '../components/ScoreSidebar';
import PieceSidebar from '../components/PieceSidebar';
import GameOverScreen from '../components/GameOverScreen';
import './playerPage.css';

const PlayerPage = () => {
    const [playerName, setPlayerName] = useState('');

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

    return (
        <div
            className="player-bg tetris-page"
            onTouchStart={game.onTouchStart}
            onTouchEnd={game.onTouchEnd}
            style={{ touchAction: 'none', userSelect: 'none' }}
        >
            <div className="tetris-layout">
                <ScoreSidebar
                    score={game.score}
                    lines={game.lines}
                    level={game.level}
                    scenario={game.scenario}
                    mtlsEnabled={game.mtlsEnabled}
                    authPolicyEnabled={game.authPolicyEnabled}
                    egressEnabled={game.egressEnabled}
                    leaderboard={game.leaderboard}
                    onToggleLeaderboard={game.toggleLeaderboard}
                />

                <GameBoard
                    board={game.board}
                    currentPiece={game.currentPiece}
                    boardRef={game.boardRef}
                    statusMsg={game.statusMsg}
                    waitingForPiece={game.waitingForPiece}
                    retryCount={game.retryCount}
                />

                <PieceSidebar
                    lastPieceMeta={game.nextPieceMeta}
                    feed={game.feed}
                />
            </div>
        </div>
    );
};

export default PlayerPage;
