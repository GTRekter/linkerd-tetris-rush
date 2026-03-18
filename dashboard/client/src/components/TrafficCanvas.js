import { useEffect, useRef } from 'react';
import './TrafficCanvas.css';

const TrafficCanvas = ({ clusters, particlesRef, canvasRef }) => {
    const clustersRef = useRef(clusters);
    useEffect(() => { clustersRef.current = clusters; }, [clusters]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        const resize = () => {
            const rect = canvas.parentElement.getBoundingClientRect();
            canvas.width = rect.width;
            canvas.height = Math.max(rect.height - 30, 100);
        };
        resize();
        window.addEventListener('resize', resize);

        let animFrame;
        const draw = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const clusterList = Object.values(clustersRef.current);

            if (clusterList.length > 0) {
                // Players node
                ctx.fillStyle = 'rgba(100,116,139,0.12)';
                ctx.beginPath();
                ctx.arc(canvas.width * 0.1, canvas.height / 2, 40, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#94a3b8';
                ctx.font = '10px system-ui';
                ctx.textAlign = 'center';
                ctx.fillText('Players', canvas.width * 0.1, canvas.height / 2 + 54);

                // Linkerd gateway
                const gx = canvas.width * 0.38 + 45;
                const gy = canvas.height / 2;
                ctx.fillStyle = 'rgba(59,130,246,0.08)';
                ctx.strokeStyle = 'rgba(59,130,246,0.25)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                if (ctx.roundRect) ctx.roundRect(gx - 45, gy - 24, 90, 48, 8);
                else ctx.rect(gx - 45, gy - 24, 90, 48);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = '#60a5fa';
                ctx.font = 'bold 9px system-ui';
                ctx.fillText('Linkerd', gx, gy - 4);
                ctx.fillText('Gateway', gx, gy + 10);

                // Cluster nodes
                const spacing = canvas.height / (clusterList.length + 1);
                clusterList.forEach((c, i) => {
                    const cx = canvas.width * 0.82;
                    const cy = spacing * (i + 1);
                    const r = 28;
                    ctx.fillStyle = (c.info.color || '#666') + (c.info.healthy ? '22' : '11');
                    ctx.beginPath();
                    ctx.arc(cx, cy, r, 0, Math.PI * 2);
                    ctx.fill();
                    if (!c.info.healthy) {
                        ctx.strokeStyle = 'rgba(239,68,68,0.6)';
                        ctx.lineWidth = 2;
                        ctx.setLineDash([4, 4]);
                        ctx.stroke();
                        ctx.setLineDash([]);
                    }
                    ctx.font = '12px system-ui';
                    ctx.textAlign = 'center';
                    ctx.fillText(c.mtls_enabled ? '🔒' : '🔓', cx, cy - 8);
                    ctx.fillStyle = c.info.color || '#666';
                    ctx.font = 'bold 9px system-ui';
                    ctx.textAlign = 'center';
                    ctx.fillText(c.info.cluster, cx, cy + r + 14);
                    if (c.stats.latency_ms > 0) {
                        ctx.fillStyle = '#f59e0b';
                        ctx.font = '8px system-ui';
                        ctx.fillText(`${c.stats.latency_ms}ms`, cx, cy + r + 24);
                    }
                });
            }

            // Particles
            const particles = particlesRef.current;
            for (let i = particles.length - 1; i >= 0; i--) {
                const p = particles[i];
                p.progress += p.speed;
                if (p.progress >= 1) { particles.splice(i, 1); continue; }
                const t = p.progress;
                const drawX = p.x + (p.targetX - p.x) * t;
                const drawY = p.y + (p.targetY - p.y) * t;
                ctx.globalAlpha = 0.7 * (1 - t);
                ctx.beginPath();
                ctx.arc(drawX, drawY, p.size, 0, Math.PI * 2);
                ctx.fillStyle = p.color;
                ctx.fill();
                ctx.globalAlpha = 0.15 * (1 - t);
                ctx.beginPath();
                ctx.arc(drawX, drawY, p.size * 3, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
            animFrame = requestAnimationFrame(draw);
        };
        draw();

        return () => {
            window.removeEventListener('resize', resize);
            if (animFrame) cancelAnimationFrame(animFrame);
        };
    }, [canvasRef, particlesRef]);

    return (
        <div className="panel-card traffic-canvas-wrapper">
            <p className="eyebrow mb-2">Live Traffic Flow</p>
            <canvas ref={canvasRef} style={{ width: '100%', height: 200, display: 'block' }}></canvas>
        </div>
    );
};

export default TrafficCanvas;
