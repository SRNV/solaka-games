import { useCallback, useRef, useState } from 'react';
import { useGameRoom } from '../../hooks/useGameRoom.ts';
import { GameLobby } from '../../components/GameLobby.tsx';
import type { ControllerFrame, InputValue } from '../../types/inputs.ts';

// Metel-specific input IDs — mirrors MetelController.tsx
type MetelInputId = 'move' | 'a' | 'b' | 'x' | 'y' | 'start';
type ControllerState = Record<MetelInputId, InputValue>;
type GameState = Record<string, ControllerState>; // controllerId → inputs

export default function Metel() {
  const stateRef = useRef<GameState>({});
  const [display, setDisplay] = useState<GameState>({});

  const onInput = useCallback((frame: ControllerFrame) => {
    for (const patch of frame) {
      const ctrl = stateRef.current[patch.controllerId] ?? {} as ControllerState;
      stateRef.current[patch.controllerId] = { ...ctrl, [patch.id]: patch.value };
    }
    setDisplay({ ...stateRef.current });
  }, []);

  const { roomUrl, controllerCount, phase, start } = useGameRoom('metel-game', onInput);

  if (phase === 'playing') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', background: '#0f0f0f', color: '#ccc', gap: '0.75rem', fontFamily: 'monospace', fontSize: '0.8rem' }}>
        <p style={{ color: '#555', margin: 0 }}>{controllerCount} manette(s)</p>
        {Object.entries(display).map(([cid, inputs]) => (
          <div key={cid} style={{ background: '#161616', border: '1px solid #2a2a2a', borderRadius: 8, padding: '0.6rem 1rem', minWidth: 240 }}>
            <p style={{ margin: '0 0 4px', color: '#444', fontSize: '0.65rem' }}>{cid.slice(0, 8)}</p>
            {Object.entries(inputs).map(([id, val]) => (
              <p key={id} style={{ margin: '1px 0', color: '#999' }}>
                {id}: {val.type === 'axis2d'
                  ? `x=${val.x.toFixed(2)} y=${val.y.toFixed(2)}`
                  : val.type === 'boolean'
                    ? `${val.pressed ? '■' : '□'}`
                    : `${val.pressed ? '■' : '□'} ${val.duration}ms`}
              </p>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <GameLobby
      gameName="Métel"
      roomUrl={roomUrl}
      controllerCount={controllerCount}
      onStart={start}
    />
  );
}
