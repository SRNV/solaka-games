import QRCode from 'react-qr-code';
import styles from './GameLobby.module.css';

interface Props {
  gameName: string;
  roomUrl: string;
  controllerCount: number;
  onStart: () => void;
}

export function GameLobby({ gameName, roomUrl, controllerCount, onStart }: Props) {
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

        <p className={styles.url}>{roomUrl}</p>

        <div className={styles.controllers}>
          <span className={styles.count}>{controllerCount}</span>
          <span className={styles.countLabel}>
            {controllerCount === 1 ? 'manette connectée' : 'manettes connectées'}
          </span>
        </div>

        <button
          className={styles.startBtn}
          onClick={onStart}
          disabled={controllerCount === 0}
        >
          Prêt — Démarrage de partie
        </button>
      </div>
    </div>
  );
}
