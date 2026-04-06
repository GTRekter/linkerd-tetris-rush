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
            onTouchMove={game.onTouchMove}
            onTouchEnd={game.onTouchEnd}
            style={{ touchAction: 'none', userSelect: 'none' }}
        >
            <div className="container-fluid h-100">
                <div className="row h-100 align-items-center justify-content-center tetris-row">
                    <div className="col-auto d-none d-md-block tetris-col-sidebar">
                        <ScoreSidebar
                            score={game.score}
                            lines={game.lines}
                            level={game.level}
                            scenario={game.scenario}
                            mtlsEnabled={game.mtlsEnabled}
                            authPolicyEnabled={game.authPolicyEnabled}
                            leaderboard={game.leaderboard}
                            onToggleLeaderboard={game.toggleLeaderboard}
                        />
                    </div>

                    <div className="col-auto d-flex justify-content-center">
                        <GameBoard
                            board={game.board}
                            currentPiece={game.currentPiece}
                            boardRef={game.boardRef}
                            statusMsg={game.statusMsg}
                            waitingForPiece={game.waitingForPiece}
                            retryCount={game.retryCount}
                        />
                    </div>

                    <div className="col-auto d-none d-md-block tetris-col-sidebar">
                        <PieceSidebar
                            lastPieceMeta={game.nextPieceMeta}
                            feed={game.feed}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PlayerPage;
