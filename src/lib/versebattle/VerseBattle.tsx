import { useCallback, useRef } from 'react';
import { useGameRoom } from '../../hooks/useGameRoom.ts';
import { GameLobby } from '../../components/GameLobby.tsx';
import { GameSettingsOverlay } from '../../components/GameSettingsOverlay.tsx';
import VerseBattleGame from './VerseBattleGame.tsx';
import type { ControllerFrame } from '../../types/inputs.ts';

export interface ConsoleProps {
  roomId: string;
  slug: string;
}

export default function VerseBattle({ roomId, slug }: ConsoleProps) {
  const gameOnInputRef = useRef<(frame: ControllerFrame) => void>(() => {});

  const onInput = useCallback((frame: ControllerFrame) => {
    gameOnInputRef.current(frame);
  }, []);

  const { roomUrl, controllers, phase, roomClosed, start } =
    useGameRoom(slug, roomId, onInput);

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
        <VerseBattleGame controllers={controllers} gameOnInputRef={gameOnInputRef} />
        <GameSettingsOverlay roomUrl={roomUrl} />
      </>
    );
  }

  return (
    <GameLobby
      gameName="Verse Battle"
      roomUrl={roomUrl}
      controllers={controllers}
      onStart={start}
    />
  );
}
