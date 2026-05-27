import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useGameRoom } from '../../hooks/useGameRoom.ts';
import { GameLobby } from '../../components/GameLobby.tsx';
import { GameSettingsOverlay } from '../../components/GameSettingsOverlay.tsx';
import VerseBattleGame, { type GameConfig, type GameVerse } from './VerseBattleGame.tsx';
import type { ControllerFrame } from '../../types/inputs.ts';
import { bibleStore } from '@/store/bible.store.ts';

export interface ConsoleProps {
  roomId: string;
  slug: string;
  onRoomClosed?: () => void;
}

// ── Config panel helpers ──────────────────────────────────────────────────────

const BTN: CSSProperties = {
  fontFamily: 'monospace', fontSize: 13, fontWeight: 700,
  padding: '5px 14px', borderRadius: 6, cursor: 'pointer',
  border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.07)',
  color: '#ccc', transition: 'all 0.12s',
};
const BTN_ON: CSSProperties = {
  ...BTN, background: 'rgba(212,172,13,0.2)', border: '1px solid #D4AC0D', color: '#D4AC0D',
};

function Btn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button style={active ? BTN_ON : BTN} onClick={onClick}>{children}</button>;
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 10, color: '#666', letterSpacing: 3, textTransform: 'uppercase', marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {children}
      </div>
    </div>
  );
}

// ── GameConfigPanel ───────────────────────────────────────────────────────────

function GameConfigPanel({ onLaunch }: { onLaunch: (cfg: GameConfig, verses: GameVerse[]) => void }) {
  const [mode,          setMode]          = useState<GameConfig['mode']>('rounds');
  const [roundCount,    setRoundCount]    = useState(10);
  const [difficulty,    setDifficulty]    = useState<GameConfig['difficulty']>('progressive');
  const [batchStyle,    setBatchStyle]    = useState<GameConfig['batchStyle']>('per-round');
  const [selectedBooks, setSelectedBooks] = useState<string[] | 'all'>('all');
  const [books,         setBooks]         = useState<Array<{ name: string }>>([]);
  const [loading,       setLoading]       = useState(false);

  useEffect(() => {
    bibleStore.books().then(setBooks).catch(console.error);
  }, []);

  const toggleBook = (name: string) => {
    setSelectedBooks(prev => {
      if (prev === 'all') return [name];
      const next = prev.includes(name) ? prev.filter(b => b !== name) : [...prev, name];
      return next.length === 0 ? 'all' : next;
    });
  };

  const handleLaunch = async () => {
    setLoading(true);
    try {
      const all = await bibleStore.randomVerses(300);
      let filtered = all as GameVerse[];
      if (selectedBooks !== 'all') {
        const set = new Set(selectedBooks);
        const book = filtered.filter(v => set.has(v.bookName));
        if (book.length >= 10) filtered = book;
      }
      onLaunch({ mode, roundCount, difficulty, books: selectedBooks, batchStyle }, filtered);
    } catch (e) {
      console.error(e);
      setLoading(false);
    }
  };

  const diffLabels: Record<GameConfig['difficulty'], string> = {
    easy: 'Facile', medium: 'Moyen', hard: 'Difficile', chaos: 'Chaos', progressive: 'Progressif',
  };

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(10,10,18,0.97)', fontFamily: 'monospace', color: '#fff', overflow: 'auto',
    }}>
      <div style={{ maxWidth: 560, width: '90%', padding: '40px 0' }}>
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{ fontFamily: 'Georgia,serif', color: '#D4AC0D', fontSize: 26, fontWeight: 700 }}>
            Bible Verse Battle
          </div>
          <div style={{ color: '#555', fontSize: 11, letterSpacing: 3, marginTop: 6 }}>
            CONFIGURATION
          </div>
        </div>

        {/* Mode */}
        <Section label="Mode">
          <Btn active={mode === 'rounds'}      onClick={() => setMode('rounds')}>Nombre de tours</Btn>
          <Btn active={mode === 'elimination'} onClick={() => setMode('elimination')}>Éliminatoire</Btn>
        </Section>

        {mode === 'rounds' && (
          <Section label="Nombre de tours">
            {([5, 10, 15, 20] as const).map(n => (
              <Btn key={n} active={roundCount === n} onClick={() => setRoundCount(n)}>{n}</Btn>
            ))}
          </Section>
        )}

        {/* Difficulty */}
        <Section label="Difficulté">
          {(Object.keys(diffLabels) as GameConfig['difficulty'][]).map(d => (
            <Btn key={d} active={difficulty === d} onClick={() => setDifficulty(d)}>
              {diffLabels[d]}
            </Btn>
          ))}
        </Section>

        {/* Batch style */}
        <Section label="Versets par tour">
          <Btn active={batchStyle === 'per-round'}   onClick={() => setBatchStyle('per-round')}>Nouveau à chaque tour</Btn>
          <Btn active={batchStyle === 'whole-game'}  onClick={() => setBatchStyle('whole-game')}>Même batch toute la partie</Btn>
        </Section>

        {/* Books */}
        <Section label="Livres">
          <Btn active={selectedBooks === 'all'} onClick={() => setSelectedBooks('all')}>Tous</Btn>
        </Section>
        {books.length > 0 && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 5, maxHeight: 170,
            overflowY: 'auto', marginBottom: 22, paddingBottom: 4,
          }}>
            {books.map(b => (
              <Btn
                key={b.name}
                active={selectedBooks !== 'all' && selectedBooks.includes(b.name)}
                onClick={() => toggleBook(b.name)}
              >
                {b.name}
              </Btn>
            ))}
          </div>
        )}

        {/* Launch */}
        <div style={{ textAlign: 'center', marginTop: 32 }}>
          <button
            onClick={handleLaunch}
            disabled={loading}
            style={{
              fontFamily: 'monospace', fontSize: 17, fontWeight: 700, letterSpacing: 2,
              padding: '12px 52px', borderRadius: 8, cursor: loading ? 'wait' : 'pointer',
              border: '2px solid #D4AC0D', background: 'rgba(212,172,13,0.12)',
              color: '#D4AC0D', opacity: loading ? 0.55 : 1, transition: 'opacity 0.2s',
            }}
          >
            {loading ? 'Chargement…' : 'Lancer la partie'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── VerseBattle ───────────────────────────────────────────────────────────────

export default function VerseBattle({ roomId, slug, onRoomClosed }: ConsoleProps) {
  const gameOnInputRef                    = useRef<(frame: ControllerFrame) => void>(() => {});
  const [gameConfig, setGameConfig]       = useState<GameConfig | null>(null);
  const [verses,     setVerses]           = useState<GameVerse[]>([]);

  const onInput = useCallback((frame: ControllerFrame) => {
    gameOnInputRef.current(frame);
  }, []);

  const { roomUrl, controllers, phase, roomClosed, start } =
    useGameRoom(slug, roomId, onInput);

  useEffect(() => { if (roomClosed) onRoomClosed?.(); }, [roomClosed]); // eslint-disable-line react-hooks/exhaustive-deps

  if (roomClosed) {
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%', color:'#888', fontFamily:'monospace' }}>
        <p>Cette partie est terminée.</p>
      </div>
    );
  }

  if (phase === 'playing') {
    return (
      <>
        {!gameConfig ? (
          <GameConfigPanel
            onLaunch={(cfg, v) => { setGameConfig(cfg); setVerses(v); }}
          />
        ) : (
          <VerseBattleGame
            controllers={controllers}
            gameOnInputRef={gameOnInputRef}
            verses={verses}
            roomId={roomId}
            config={gameConfig}
          />
        )}
        <GameSettingsOverlay roomUrl={roomUrl} />
      </>
    );
  }

  return (
    <GameLobby
      gameName="Bible Verse Battle"
      roomUrl={roomUrl}
      controllers={controllers}
      onStart={start}
    />
  );
}
