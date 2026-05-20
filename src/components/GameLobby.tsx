import QRCode from 'react-qr-code';
import styles from './GameLobby.module.css';
import type { ControllerDisplay } from '../hooks/useGameRoom.ts';

interface Props {
  gameName: string;
  roomUrl: string;
  controllers: ControllerDisplay[];
  onStart: () => void;
}

export function GameLobby({ gameName, roomUrl, controllers, onStart }: Props) {
  const connectedCount = controllers.filter(c => c.isConnected).length;
  return (
    <div className={styles.lobby}>
      <div className={styles.card}>
        <h2 className={styles.title}>{gameName}</h2>
        <p className={styles.subtitle}>Scannez pour rejoindre</p>

        <div className={styles.qrWrapper}>
          {roomUrl ? (
            <QRCode value={roomUrl} size={200} bgColor="#fff" fgColor="#1a1a1a" />
          ) : (
            <div className={styles.qrPlaceholder} />
          )}
        </div>

        {import.meta.env.DEV ? (
          <button
            className={styles.devOpenBtn}
            onClick={() => window.open(roomUrl, '_blank')}
          >
            Ouvrir une manette
          </button>
        ) : (
          <p className={styles.url}>{roomUrl}</p>
        )}

        <div className={styles.controllers}>
          <span className={styles.count}>{connectedCount}</span>
          <span className={styles.countLabel}>
            {connectedCount === 1 ? 'manette connectée' : 'manettes connectées'}
          </span>
        </div>

        {controllers.length > 0 && (
          <ul className={styles.pseudoList}>
            {controllers.map(c => (
              <li key={c.id} className={c.isConnected ? styles.pseudoOnline : styles.pseudoOffline}>
                {c.pseudo}
                {!c.isConnected && ' (reconnexion…)'}
              </li>
            ))}
          </ul>
        )}

        <button
          className={styles.startBtn}
          onClick={onStart}
          disabled={connectedCount === 0}
        >
          Start
        </button>
      </div>
    </div>
  );
}
