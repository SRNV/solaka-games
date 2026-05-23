import { useCallback, useEffect, useRef, useState } from 'react';
import { useGameRoom } from '../../hooks/useGameRoom.ts';
import { GameLobby } from '../../components/GameLobby.tsx';
import { GameSettingsOverlay } from '../../components/GameSettingsOverlay.tsx';
import VerseBattleGame from './VerseBattleGame.tsx';
import type { ControllerFrame } from '../../types/inputs.ts';
import { bibleStore, type GameVerse } from '@/store/bible.store.ts';

export interface ConsoleProps {
  roomId: string;
  slug: string;
  onRoomClosed?: () => void;
}

export default function VerseBattle({ roomId, slug, onRoomClosed }: ConsoleProps) {
  const gameOnInputRef = useRef<(frame: ControllerFrame) => void>(() => {});
  const [verses, setVerses] = useState<GameVerse[]>([]);

  useEffect(() => {
    bibleStore.randomVerses(60).then(setVerses).catch(console.error);
  }, []);

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
        <VerseBattleGame controllers={controllers} gameOnInputRef={gameOnInputRef} verses={verses} roomId={roomId} />
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
