export async function joinGame(name) {
    const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    return res.json();
}

export async function fetchNextPiece(playerId) {
    return fetch(`/api/next-piece?player_id=${playerId}`);
}

export async function submitScore(playerId, linesCleared, level) {
    const res = await fetch('/api/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: playerId, lines_cleared: linesCleared, level }),
    });
    return res.json();
}

export async function fetchLeaderboard() {
    const res = await fetch('/api/leaderboard');
    return res.json();
}

export async function fetchGameInfo() {
    const res = await fetch('/api/info');
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
}
