import { useEffect, useRef, useState } from 'react';
import { getGamesStompClient, onGamesStompConnect } from '../gamesStompClient.ts';
import { randomUUID } from '../uuid.ts';

export type ControllerPhase = 'waiting' | 'playing';

export interface UseControllerRoomResult {
  phase: ControllerPhase;
  registered: boolean;
  error: string | null;
  controllerId: string;
}

function getOrCreateControllerId(): string {
  const key = 'controller-uuid';
  try {
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = randomUUID();
      sessionStorage.setItem(key, id);
    }
    return id;
  } catch {
    return randomUUID();
  }
}

export function useControllerRoom(roomId: string): UseControllerRoomResult {
  const controllerId = useRef(getOrCreateControllerId()).current;
  const [phase, setPhase] = useState<ControllerPhase>('waiting');
  const [registered, setRegistered] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/games-api/api/rooms/${roomId}/controllers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ controllerId }),
    })
      .then(res => {
        if (!res.ok) throw new Error('Room introuvable');
        setRegistered(true);
      })
      .catch(e => setError((e as Error).message));

    const cancel = onGamesStompConnect(() => {
      const client = getGamesStompClient();
      const sub = client.subscribe(`/topic/room/${roomId}`, (msg) => {
        const event = JSON.parse(msg.body);
        if (event.type === 'game_started') setPhase('playing');
      });
      return () => sub.unsubscribe();
    });

    return cancel;
  }, [roomId]);

  return { phase, registered, error, controllerId };
}
