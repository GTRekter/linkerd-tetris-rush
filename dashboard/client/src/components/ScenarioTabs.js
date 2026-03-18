import './ScenarioTabs.css';

const MODES = [
    { id: 'federated', label: 'Federated' },
    { id: 'mirrored', label: 'Mirrored' },
    { id: 'gateway', label: 'Gateway' },
];

const ModeSelector = ({ currentMode, onModeChange }) => (
    <div className="mode-selector">
        <span className="mode-label">Multicluster Mode</span>
        <select
            className="mode-dropdown"
            value={currentMode}
            onChange={e => onModeChange(e.target.value)}
        >
            {MODES.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
            ))}
        </select>
    </div>
);

export default ModeSelector;
