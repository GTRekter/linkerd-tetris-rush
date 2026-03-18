import { ghostY } from '../services/gameEngine';

const BOARD_W = 10;
const BOARD_H = 20;

const GameBoard = ({ board, currentPiece, boardRef, statusMsg, waitingForPiece, retryCount }) => {
    const activeCells = new Set();
    const ghostCells = new Set();

    if (currentPiece) {
        const gy = ghostY(currentPiece, boardRef.current);
        for (let r = 0; r < currentPiece.matrix.length; r++) {
            for (let c = 0; c < currentPiece.matrix[0].length; c++) {
                if (!currentPiece.matrix[r][c]) continue;
                activeCells.add(`${currentPiece.x + c}-${currentPiece.y + r}`);
                if (gy !== currentPiece.y)
                    ghostCells.add(`${currentPiece.x + c}-${gy + r}`);
            }
        }
    }

    return (
        <div className="tetris-board-wrap">
            {statusMsg && (
                <div className={`tetris-status-msg feedback ${statusMsg.type}`}>
                    {statusMsg.text}
                </div>
            )}

            {waitingForPiece && (
                <div className="tetris-waiting">
                    <span className="waiting-spinner"></span>
                    <span className="text-white-50" style={{ fontSize: '0.75rem' }}>
                        {retryCount > 0 ? `Rerouting... (${retryCount})` : 'Fetching piece...'}
                    </span>
                </div>
            )}

            <div className="tetris-board">
                {Array.from({ length: BOARD_H }, (_, y) =>
                    Array.from({ length: BOARD_W }, (_, x) => {
                        const key = `${x}-${y}`;
                        const locked = board[y][x];
                        const isActive = activeCells.has(key);
                        const isGhost = ghostCells.has(key) && !isActive;

                        let bg = null;
                        let border = null;
                        let cls = 'tetris-cell';

                        if (locked) {
                            bg = locked.color;
                            border = locked.clusterColor;
                            cls += locked.corrupted ? ' corrupted' : ' locked';
                        } else if (isActive) {
                            bg = currentPiece.corrupted ? '#2a2a3e' : currentPiece.color;
                            border = currentPiece.clusterColor;
                            cls += currentPiece.corrupted ? ' active corrupted' : ' active';
                        } else if (isGhost) {
                            cls += ' ghost';
                        } else {
                            cls += ' empty';
                        }

                        return (
                            <div
                                key={key}
                                className={cls}
                                style={{ background: bg, borderColor: border }}
                            />
                        );
                    })
                )}
            </div>
        </div>
    );
};

export default GameBoard;
