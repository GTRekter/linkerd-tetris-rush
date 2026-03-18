import './QRCodeSidebar.css';

const QRCodeSidebar = ({ origin }) => (
    <div className="panel-card text-center">
        <p className="eyebrow mb-2">Scan to Play</p>
        <img src="/api/qr" alt="QR Code" className="qr-img mb-2" />
        <div className="text-white-50 small" style={{ wordBreak: 'break-all' }}>
            {origin}/go
        </div>
    </div>
);

export default QRCodeSidebar;
