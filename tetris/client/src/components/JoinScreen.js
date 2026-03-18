import linkyImage from '../images/linky.png';
import './JoinScreen.css';

const JoinScreen = ({ playerName, onNameChange, onJoin }) => (
    <div className="full-height-container text-white">
        <div className="container">
            <div className="row justify-content-center">
                <div className="col-12 col-md-5 col-lg-4 text-center py-5">
                    <div className="player-join-card panel-card">
                        <img src={linkyImage} alt="Linky mascot" className="icon" />
                        <h1 className="gradient-title mb-2">Tetris Rush</h1>
                        <p className="text-white-50 mb-4" style={{ fontSize: '0.9rem' }}>
                            Every piece is a request routed through Linkerd across Kubernetes clusters.
                            Watch the mesh in action as you play.
                        </p>
                        <input
                            type="text"
                            className="form-control mb-4"
                            placeholder="Your name"
                            maxLength={20}
                            value={playerName}
                            onChange={e => onNameChange(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && onJoin()}
                            autoComplete="off"
                            autoFocus
                        />
                        <button className="btn btn-primary btn-lg w-100 fw-bold" onClick={onJoin}>
                            Start Playing
                        </button>
                        <p className="text-white-50 mt-3 mb-0" style={{ fontSize: '0.75rem' }}>
                            Tap to rotate &nbsp;·&nbsp; Swipe to move &nbsp;·&nbsp; Swipe down to drop
                        </p>
                    </div>
                </div>
            </div>
        </div>
    </div>
);

export default JoinScreen;
