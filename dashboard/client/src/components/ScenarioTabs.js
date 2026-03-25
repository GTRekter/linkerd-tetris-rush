import './ScenarioTabs.css';

const MODES = [
    { id: 'federated', label: 'Federated' },
    { id: 'mirrored', label: 'Mirrored' },
    { id: 'gateway', label: 'Gateway' },
];

const ModeSelector = ({ currentMode, onModeChange, loading }) => (
    <div className="mode-selector">
        <span className="mode-label">Multicluster Mode</span>
        <div className="mode-dropdown-wrapper">
            <select
                className={`mode-dropdown${loading ? ' mode-dropdown--loading' : ''}`}
                value={currentMode}
                onChange={e => onModeChange(e.target.value)}
                disabled={loading}
            >
                {MODES.map(m => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                ))}
            </select>
            {loading && <span className="mode-spinner" />}
        </div>
    </div>
);

export default ModeSelector;
