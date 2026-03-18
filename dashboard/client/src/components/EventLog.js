import './EventLog.css';

const EventLog = ({ eventLog }) => (
    <div className="panel-card sidebar-log">
        <p className="eyebrow mb-2">Event Log</p>
        <div className="event-log-list">
            {eventLog.map(ev => (
                <div
                    key={ev.id}
                    className="event-row d-flex align-items-start gap-1 py-1"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', fontSize: '0.68rem' }}
                >
                    <span className="text-white-50" style={{ whiteSpace: 'nowrap' }}>{ev.time}</span>
                    <span
                        className="badge rounded-pill text-white px-1"
                        style={{ background: ev.color, fontSize: '0.58rem', flexShrink: 0 }}
                    >
                        {ev.cluster}
                    </span>
                    <span>{ev.text}</span>
                </div>
            ))}
        </div>
    </div>
);

export default EventLog;
