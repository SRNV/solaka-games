import { useEffect, useRef, useState } from 'react';
import { getGamesStompClient, onGamesStompConnect } from '../gamesStompClient.ts';
import { randomUUID } from '../uuid.ts';
import type { ControllerFrame } from '../types/inputs.ts';

export type RoomPhase = 'lobby' | 'playing';

export interface UseGameRoomResult {
  roomId: string;
  roomUrl: string;
  controllerCount: number;
  phase: RoomPhase;
  start: () => void;
}

export function useGameRoom(
  slug: string,
  onInput?: (frame: ControllerFrame) => void,
): UseGameRoomResult {
  const roomId = useRef(randomUUID()).current;
  const [phase, setPhase] = useState<RoomPhase>('lobby');
  const [controllerCount, setControllerCount] = useState(0);
  const [roomUrl, setRoomUrl] = useState('');
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;

  useEffect(() => {
    const host = import.meta.env.VITE_GAME_HOST || window.location.origin;
    setRoomUrl(`${host}/games/${slug}/${roomId}`);

    fetch('/games-api/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, slug }),
    });

    const cancel = onGamesStompConnect(() => {
      const client = getGamesStompClient();
      const subs = [
        client.subscribe(`/topic/room/${roomId}`, (msg) => {
          const event = JSON.parse(msg.body);
          if (event.type === 'controller_joined') setControllerCount(event.count);
          else if (event.type === 'game_started') setPhase('playing');
        }),
        client.subscribe(`/topic/room/${roomId}/input`, (msg) => {
          onInputRef.current?.(JSON.parse(msg.body) as ControllerFrame);
        }),
      ];
      return () => subs.forEach(s => s.unsubscribe());
    });

    return cancel;
  }, [slug, roomId]);

  function start() {
    const client = getGamesStompClient();
    client.publish({
      destination: `/topic/room/${roomId}`,
      body: JSON.stringify({ type: 'game_started' }),
    });
    setPhase('playing');
  }

  return { roomId, roomUrl, controllerCount, phase, start };
}
