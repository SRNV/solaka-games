import { useCallback, useEffect, useRef, useState } from 'react';
import { useGameRoom } from '../../hooks/useGameRoom.ts';
import { GameLobby } from '../../components/GameLobby.tsx';
import type { ControllerFrame, InputValue } from '../../types/inputs.ts';

type MetelInputId = 'move' | 'a' | 'b' | 'x' | 'y' | 'start';
type ControllerState = Record<string, InputValue>;
type GameState = Record<string, ControllerState>;

export interface ConsoleProps {
  roomId: string;
  slug: string;
}

export default function Metel({ roomId, slug }: ConsoleProps) {
  const stateRef = useRef<GameState>({});

  const onInput = useCallback((frame: ControllerFrame) => {
    for (const patch of frame.patches) {
      const ctrl = stateRef.current[patch.controllerId] ?? {} as ControllerState;
      stateRef.current[patch.controllerId] = { ...ctrl, [patch.id]: patch.value };
    }
  }, []);

  const { roomUrl, controllers, controllerCount, phase, roomClosed, start } =
    useGameRoom(slug, roomId, onInput);

  if (roomClosed) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888', fontFamily: 'monospace' }}>
        <p>Cette partie est terminée.</p>
      </div>
    );
  }

  if (phase === 'playing') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', background: '#0f0f0f', color: '#ccc', gap: '0.75rem', fontFamily: 'monospace', fontSize: '0.8rem' }}>
        <p style={{ color: '#555', margin: 0 }}>{controllerCount} manette(s)</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'center', padding: '20px', overflowY: 'auto' }}>
          {controllers.map(ctrl => (
            <ControllerCard key={ctrl.id} controller={ctrl} stateRef={stateRef} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <GameLobby
      gameName="Métel"
      roomUrl={roomUrl}
      controllers={controllers}
      onStart={start}
    />
  );
}

function ControllerCard({ controller, stateRef }: { controller: any, stateRef: React.MutableRefObject<GameState> }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    let rafId: number;
    const loop = () => {
      // Only re-render this card at 30Hz to save CPU
      setTick(t => t + 1);
      rafId = setTimeout(() => {
        rafId = requestAnimationFrame(loop);
      }, 33) as any;
    };
    rafId = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(rafId);
    };
  }, []);

  const inputs = stateRef.current[controller.id] ?? {};

  return (
    <div style={{ background: '#161616', border: '1px solid #2a2a2a', borderRadius: 8, padding: '0.6rem 1rem', minWidth: 200 }}>
      <p style={{ margin: '0 0 4px', color: '#444', fontSize: '0.65rem' }}>
        {controller.pseudo ?? controller.id.slice(0, 8)}
      </p>
      {Object.entries(inputs).map(([id, val]) => (
        <p key={id} style={{ margin: '1px 0', color: '#999', fontSize: '0.7rem' }}>
          {id}: {val.type === 'axis2d'
            ? `x=${val.x.toFixed(2)} y=${val.y.toFixed(2)}`
            : val.type === 'boolean'
              ? `${val.pressed ? '■' : '□'}`
              : `${val.pressed ? '■' : '□'} ${val.duration}ms`}
        </p>
      ))}
    </div>
  );
}
