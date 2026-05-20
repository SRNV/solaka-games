import { PulseLoader } from 'react-spinners';
import type { GamepadTheme } from './gamepad3d/themes.ts';
import type { NavEntry } from '../hooks/useGamepadCommon.ts';
import styles from './Gamepad3D.module.css';

export function Spinner({ color }: { color: string }) {
  return (
    <div className={styles.spinner} style={{ 
      position: 'absolute',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: 100,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: 'none',
      animation: 'none',
      background: 'none'
    }}>
      <PulseLoader color={color} size={30} margin={10} />
    </div>
  );
}

export function GamepadOverlay({ active, theme, loading }: {
  active: boolean;
  theme: GamepadTheme;
  loading: boolean;
}) {
  return (
    <>
      {!active && loading && <Spinner color={theme.outlineColor} />}
      {!active && (
        <div className={styles.waitingOverlay}>
          <Spinner color={theme.outlineColor} />
        </div>
      )}
    </>
  );
}

export function SettingsModal({ 
  show, 
  onClose, 
  navIndex, 
  configEntries, 
  currentEntry, 
  onNavigate 
}: {
  show: boolean;
  onClose: () => void;
  navIndex: number;
  configEntries: NavEntry[];
  currentEntry: NavEntry;
  onNavigate: (dir: 1 | -1) => void;
}) {
  if (!show) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <h3>Personnalisation</h3>

        <div className={styles.themeNav}>
          <button
            className={styles.navArrow}
            onClick={() => onNavigate(-1)}
            disabled={navIndex === 0}
          >
            ‹
          </button>
          <span className={styles.themeName}>
            {currentEntry.type === 'matcap' ? '◈ ' : ''}{currentEntry.name}
          </span>
          <button
            className={styles.navArrow}
            onClick={() => onNavigate(1)}
            disabled={navIndex === configEntries.length - 1}
          >
            ›
          </button>
        </div>
        <div className={styles.themeIndicator}>
          {navIndex + 1} / {configEntries.length}
        </div>

        <button className={styles.closeBtn} onClick={onClose}>Fermer</button>
      </div>
    </div>
  );
}
