import { PIECE_COLORS, BASE_SHAPES } from '../constants/pieces';

export const BOARD_W = 10;
export const BOARD_H = 20;
export const DROP_INTERVALS = [800, 717, 633, 550, 467, 383, 300, 217, 133, 100];

export function createBoard() {
    return Array.from({ length: BOARD_H }, () => Array(BOARD_W).fill(null));
}

export function rotateCW(matrix) {
    const rows = matrix.length;
    const cols = matrix[0].length;
    const out = Array.from({ length: cols }, () => Array(rows).fill(0));
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
            out[c][rows - 1 - r] = matrix[r][c];
    return out;
}

export function spawnX(matrix) {
    return Math.floor((BOARD_W - matrix[0].length) / 2);
}

export function canPlace(matrix, bx, by, board) {
    for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix[0].length; c++) {
            if (!matrix[r][c]) continue;
            const nx = bx + c;
            const ny = by + r;
            if (nx < 0 || nx >= BOARD_W) return false;
            if (ny >= BOARD_H) return false;
            if (ny >= 0 && board[ny][nx]) return false;
        }
    }
    return true;
}

export function lockPiece(piece, board) {
    const b = board.map(row => [...row]);
    for (let r = 0; r < piece.matrix.length; r++) {
        for (let c = 0; c < piece.matrix[0].length; c++) {
            if (!piece.matrix[r][c]) continue;
            const nx = piece.x + c;
            const ny = piece.y + r;
            if (ny >= 0 && ny < BOARD_H) {
                b[ny][nx] = {
                    color: piece.corrupted ? '#1e1e2e' : piece.color,
                    clusterColor: piece.clusterColor || '#555',
                    cluster: piece.cluster || '',
                    corrupted: piece.corrupted,
                    egress: piece.egress,
                };
            }
        }
    }
    return b;
}

export function clearLines(board) {
    const surviving = board.filter(row => row.some(cell => !cell));
    const linesCleared = BOARD_H - surviving.length;
    const empty = Array.from({ length: linesCleared }, () => Array(BOARD_W).fill(null));
    return { board: [...empty, ...surviving], linesCleared };
}

export function ghostY(piece, board) {
    let gy = piece.y;
    while (canPlace(piece.matrix, piece.x, gy + 1, board)) gy++;
    return gy;
}

export function buildPiece(apiData) {
    const type = apiData.piece_type;
    const matrix = BASE_SHAPES[type];
    return {
        type,
        matrix,
        x: spawnX(matrix),
        y: 0,
        color: apiData.corrupted ? '#2a2a3e' : PIECE_COLORS[type],
        clusterColor: apiData.cluster_color || '#555',
        cluster: apiData.cluster,
        corrupted: apiData.corrupted,
        egress: apiData.egress,
    };
}

export function applyWallKick(piece, rotated, board) {
    for (const dx of [0, -1, 1, -2, 2]) {
        if (canPlace(rotated, piece.x + dx, piece.y, board)) {
            return { ...piece, matrix: rotated, x: piece.x + dx };
        }
    }
    return null;
}

export function nextLevelState(currentLines, linesCleared) {
    const newLines = currentLines + linesCleared;
    const newLevel = Math.floor(newLines / 10) + 1;
    return { lines: newLines, level: newLevel };
}
