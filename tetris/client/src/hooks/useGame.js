import { useState, useEffect, useRef, useCallback } from 'react';
import {
    createBoard, canPlace, lockPiece, clearLines, ghostY,
    rotateCW, buildPiece, applyWallKick, nextLevelState,
    DROP_INTERVALS,
} from '../services/gameEngine';
import {
    fetchNextPiece as apiFetchNextPiece,
    submitScore as apiSubmitScore,
    fetchLeaderboard,
    fetchGameInfo,
} from '../services/gameApi';

export function useGame() {
    const [joined, setJoined] = useState(false);
    const [board, setBoard] = useState(createBoard);
    const [currentPiece, setCurrentPiece] = useState(null);
    const [score, setScore] = useState(0);
    const [lines, setLines] = useState(0);
    const [level, setLevel] = useState(1);
    const [gameOver, setGameOver] = useState(false);
    const [waitingForPiece, setWaitingForPiece] = useState(false);
    const [retryCount, setRetryCount] = useState(0);
    const [scenario, setScenario] = useState('httproute');
    const [mtlsEnabled, setMtlsEnabled] = useState(true);
    const [authPolicyEnabled, setAuthPolicyEnabled] = useState(false);
    const [statusMsg, setStatusMsg] = useState(null);
    const [nextPieceMeta, setNextPieceMeta] = useState(null);
    const [feed, setFeed] = useState([]);
    const nextPieceRef = useRef(null);       // queued { piece, data } for next turn
    const [leaderboard, setLeaderboard] = useState(null);

    const boardRef = useRef(createBoard());
    const currentPieceRef = useRef(null);
    const linesRef = useRef(0);
    const levelRef = useRef(1);
    const gameOverRef = useRef(false);
    const waitingRef = useRef(false);
    const playerIdRef = useRef(null);
    const dropTimerRef = useRef(null);
    const lastDropRef = useRef(0);
    const touchStartRef = useRef({ x: 0, y: 0, time: 0 });

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------
    const showStatus = useCallback((type, text, duration = 3500) => {
        setStatusMsg({ type, text });
        setTimeout(() => setStatusMsg(null), duration);
    }, []);

    const addFeedItem = useCallback((item) => {
        setFeed(prev => [{ id: Date.now() + Math.random(), ...item }, ...prev].slice(0, 30));
    }, []);

    // ---------------------------------------------------------------------------
    // Poll /api/info for scenario changes
    // ---------------------------------------------------------------------------
    useEffect(() => {
        if (!joined) return;
        const poll = async () => {
            try {
                const data = await fetchGameInfo();
                setScenario(prev => {
                    if (prev !== data.active_scenario) {
                        showStatus('info', `Module: ${data.active_scenario.replace('-', ' ')}`);
                    }
                    return data.active_scenario || prev;
                });
                setMtlsEnabled(data.mtls_enabled !== false);
                setAuthPolicyEnabled(data.auth_policy_enabled || false);
            } catch { /* cluster may be down */ }
        };
        poll();
        const id = setInterval(poll, 3000);
        return () => clearInterval(id);
    }, [joined, showStatus]);

    // ---------------------------------------------------------------------------
    // Fetch a single piece from the API (with retry loop for 403/503/504)
    // ---------------------------------------------------------------------------
    const fetchOnePiece = useCallback(async (pid) => {
        while (!gameOverRef.current) {
            try {
                const res = await apiFetchNextPiece(pid);

                if (res.status === 403) {
                    let cluster = 'DENIED';
                    try {
                        const err = await res.json();
                        cluster = err.detail?.cluster || 'DENIED';
                    } catch { /* Linkerd Server deny returns non-JSON body */ }
                    setRetryCount(c => c + 1);
                    addFeedItem({ cluster, clusterColor: '#ef4444', piece: '?', latency: 0, denied: true, corrupted: false });
                    showStatus('warning', 'Access denied — traffic blocked by Server policy');
                    await new Promise(r => setTimeout(r, 800));
                    continue;
                }

                if (res.status === 502) {
                    setRetryCount(c => c + 1);
                    addFeedItem({ cluster: 'DENIED', clusterColor: '#ef4444', piece: '?', latency: 0, denied: true, corrupted: false });
                    showStatus('warning', 'Access denied — traffic blocked by Server policy');
                    await new Promise(r => setTimeout(r, 800));
                    continue;
                }

                if (res.status === 503 || res.status === 504) {
                    addFeedItem({ cluster: 'DOWN', clusterColor: '#ef4444', piece: '?', latency: 0, denied: true });
                    showStatus('danger', 'Cluster down — waiting for failover...', 5000);
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }

                const data = await res.json();
                const piece = buildPiece(data);

                if (data.corrupted) showStatus('danger', `mTLS OFF — piece intercepted! ${data.corrupted_from} → ${piece.type}`, 4000);

                const meta = {
                    cluster: data.cluster,
                    clusterColor: data.cluster_color,
                    latency: data.latency_ms,
                    mtls: data.mtls,
                    corrupted: data.corrupted,
                    piece: piece.type,
                };
                addFeedItem({ cluster: data.cluster, clusterColor: data.cluster_color, piece: piece.type, latency: data.latency_ms, corrupted: data.corrupted, denied: false });

                return { piece, meta };
            } catch {
                showStatus('danger', 'Connection lost — retrying...', 5000);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        return null;
    }, [addFeedItem, showStatus]);

    // ---------------------------------------------------------------------------
    // Fetch next piece — uses a one-piece queue so sidebar shows the upcoming piece
    // ---------------------------------------------------------------------------
    const fetchNextPiece = useCallback(async (pid) => {
        if (gameOverRef.current) return;
        waitingRef.current = true;
        setWaitingForPiece(true);

        // Use the queued piece as current (if we have one)
        let currentResult = nextPieceRef.current;
        nextPieceRef.current = null;
        setNextPieceMeta(null);

        // If no queued piece (first piece of the game), fetch one now
        if (!currentResult) {
            currentResult = await fetchOnePiece(pid);
            if (!currentResult) { waitingRef.current = false; setWaitingForPiece(false); return; }
        }

        const { piece } = currentResult;

        if (!canPlace(piece.matrix, piece.x, piece.y, boardRef.current)) {
            setGameOver(true);
            gameOverRef.current = true;
            waitingRef.current = false;
            setWaitingForPiece(false);
            return;
        }

        currentPieceRef.current = piece;
        setCurrentPiece(piece);
        lastDropRef.current = performance.now();
        waitingRef.current = false;
        setWaitingForPiece(false);
        setRetryCount(0);

        // Pre-fetch the next piece and show it in the sidebar
        const nextResult = await fetchOnePiece(pid);
        if (nextResult) {
            nextPieceRef.current = nextResult;
            setNextPieceMeta(nextResult.meta);
        }
    }, [fetchOnePiece]);

    // ---------------------------------------------------------------------------
    // Submit score
    // ---------------------------------------------------------------------------
    const submitScore = useCallback(async (linesCleared, currentLevel, pid) => {
        try {
            const data = await apiSubmitScore(pid, linesCleared, currentLevel);
            setScore(data.score);
            setLines(data.lines);
            setLevel(data.level);
            levelRef.current = data.level;
        } catch { /* ignore */ }
    }, []);

    // ---------------------------------------------------------------------------
    // Game actions
    // ---------------------------------------------------------------------------
    const tryMove = useCallback((dx, dy) => {
        const p = currentPieceRef.current;
        if (!p || gameOverRef.current || waitingRef.current) return false;
        if (canPlace(p.matrix, p.x + dx, p.y + dy, boardRef.current)) {
            const moved = { ...p, x: p.x + dx, y: p.y + dy };
            currentPieceRef.current = moved;
            setCurrentPiece(moved);
            return true;
        }
        return false;
    }, []);

    const tryRotate = useCallback(() => {
        const p = currentPieceRef.current;
        if (!p || gameOverRef.current || waitingRef.current) return;
        const kicked = applyWallKick(p, rotateCW(p.matrix), boardRef.current);
        if (kicked) {
            currentPieceRef.current = kicked;
            setCurrentPiece(kicked);
        }
    }, []);

    const lockCurrentPiece = useCallback((piece) => {
        const p = piece || currentPieceRef.current;
        if (!p) return;

        const newBoard = lockPiece(p, boardRef.current);
        const { board: clearedBoard, linesCleared } = clearLines(newBoard);

        boardRef.current = clearedBoard;
        setBoard(clearedBoard);
        currentPieceRef.current = null;
        setCurrentPiece(null);

        if (linesCleared > 0) {
            const { lines: newLines, level: newLevel } = nextLevelState(linesRef.current, linesCleared);
            linesRef.current = newLines;
            levelRef.current = newLevel;

            // Optimistic local score update so UI reflects changes immediately
            const LINE_SCORES = { 1: 100, 2: 300, 3: 500, 4: 800 };
            const points = (LINE_SCORES[Math.min(linesCleared, 4)] || 0) * Math.max(newLevel, 1);
            setScore(prev => prev + points);
            setLines(newLines);
            setLevel(newLevel);

            submitScore(linesCleared, newLevel, playerIdRef.current);
        }

        fetchNextPiece(playerIdRef.current);
    }, [fetchNextPiece, submitScore]);

    const hardDrop = useCallback(() => {
        const p = currentPieceRef.current;
        if (!p || gameOverRef.current || waitingRef.current) return;
        const dropped = { ...p, y: ghostY(p, boardRef.current) };
        currentPieceRef.current = dropped;
        lockCurrentPiece(dropped);
    }, [lockCurrentPiece]);

    // ---------------------------------------------------------------------------
    // Game loop
    // ---------------------------------------------------------------------------
    useEffect(() => {
        if (!joined || gameOver) return;

        const loop = (now) => {
            if (gameOverRef.current) return;
            if (!waitingRef.current && currentPieceRef.current) {
                const interval = DROP_INTERVALS[Math.min(levelRef.current - 1, 9)];
                if (now - lastDropRef.current >= interval) {
                    lastDropRef.current = now;
                    const p = currentPieceRef.current;
                    if (!canPlace(p.matrix, p.x, p.y + 1, boardRef.current)) {
                        lockCurrentPiece(p);
                    } else {
                        const moved = { ...p, y: p.y + 1 };
                        currentPieceRef.current = moved;
                        setCurrentPiece(moved);
                    }
                }
            }
            dropTimerRef.current = requestAnimationFrame(loop);
        };

        dropTimerRef.current = requestAnimationFrame(loop);
        return () => { if (dropTimerRef.current) cancelAnimationFrame(dropTimerRef.current); };
    }, [joined, gameOver, lockCurrentPiece]);

    // ---------------------------------------------------------------------------
    // Keyboard controls
    // ---------------------------------------------------------------------------
    useEffect(() => {
        if (!joined) return;
        const onKey = (e) => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', ' '].includes(e.key)) e.preventDefault();
            if (e.key === 'ArrowLeft') tryMove(-1, 0);
            else if (e.key === 'ArrowRight') tryMove(1, 0);
            else if (e.key === 'ArrowDown') tryMove(0, 1);
            else if (e.key === 'ArrowUp' || e.key === 'z' || e.key === 'Z') tryRotate();
            else if (e.key === ' ') hardDrop();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [joined, tryMove, tryRotate, hardDrop]);

    // ---------------------------------------------------------------------------
    // Touch handlers
    // ---------------------------------------------------------------------------
    const onTouchStart = (e) => {
        const t = e.touches[0];
        touchStartRef.current = { x: t.clientX, y: t.clientY, time: Date.now() };
    };

    const onTouchEnd = (e) => {
        const t = e.changedTouches[0];
        const dx = t.clientX - touchStartRef.current.x;
        const dy = t.clientY - touchStartRef.current.y;
        const dt = Date.now() - touchStartRef.current.time;
        const dist = Math.hypot(dx, dy);
        if (dist < 12 && dt < 200) tryRotate();
        else if (Math.abs(dx) > Math.abs(dy)) {
            if (dx > 25) tryMove(1, 0);
            else if (dx < -25) tryMove(-1, 0);
        } else {
            if (dy > 25) hardDrop();
        }
    };

    // ---------------------------------------------------------------------------
    // Join / reset
    // ---------------------------------------------------------------------------
    const onJoined = useCallback((pid) => {
        playerIdRef.current = pid;
        setJoined(true);
        setTimeout(() => fetchNextPiece(pid), 100);
    }, [fetchNextPiece]);

    const resetGame = useCallback(() => {
        const fresh = createBoard();
        boardRef.current = fresh;
        currentPieceRef.current = null;
        linesRef.current = 0;
        levelRef.current = 1;
        gameOverRef.current = false;
        waitingRef.current = false;
        setBoard(fresh);
        setCurrentPiece(null);
        setScore(0);
        setLines(0);
        setLevel(1);
        setGameOver(false);
        setWaitingForPiece(false);
        setFeed([]);
        setRetryCount(0);
        nextPieceRef.current = null;
        setNextPieceMeta(null);
    }, []);

    const startNewGame = useCallback(() => {
        resetGame();
        setTimeout(() => fetchNextPiece(playerIdRef.current), 100);
    }, [resetGame, fetchNextPiece]);

    const toggleLeaderboard = useCallback(async () => {
        if (leaderboard) { setLeaderboard(null); return; }
        try { setLeaderboard(await fetchLeaderboard()); } catch { /* ignore */ }
    }, [leaderboard]);

    return {
        joined, board, currentPiece, boardRef,
        score, lines, level, gameOver,
        waitingForPiece, retryCount,
        scenario, mtlsEnabled, authPolicyEnabled,
        statusMsg, nextPieceMeta, feed, leaderboard,
        onJoined, startNewGame, toggleLeaderboard,
        onTouchStart, onTouchEnd,
    };
}
