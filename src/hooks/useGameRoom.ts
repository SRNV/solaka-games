import { useEffect, useRef, useState } from 'react';
import { getGamesStompClient, onGamesStompConnect } from '../gamesStompClient.ts';
import type { ControllerFrame } from '../types/inputs.ts';

export type RoomPhase = 'lobby' | 'playing';

export interface ControllerDisplay {
  id: string;
  pseudo: string;
  isConnected: boolean;
}

export interface UseGameRoomResult {
  roomUrl: string;
  controllers: ControllerDisplay[];
  controllerCount: number;
  phase: RoomPhase;
  roomClosed: boolean;
  start: () => void;
}

function buildControllerUrl(slug: string, roomId: string): string {
  const host = import.meta.env.VITE_GAME_HOST || window.location.origin;
  return `${host}/games/${slug}/${roomId}`;
}

export function useGameRoom(
  slug: string,
  roomId: string,
  onInput?: (frame: ControllerFrame) => void,
): UseGameRoomResult {
  const [phase, setPhase] = useState<RoomPhase>('lobby');
  const [controllers, setControllers] = useState<ControllerDisplay[]>([]);
  const [roomClosed, setRoomClosed] = useState(false);
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;

  const roomUrl = buildControllerUrl(slug, roomId);

  // Hydrate room state on mount — supports console page reload/reconnect
  useEffect(() => {
    fetch(`/games-api/api/rooms/${roomId}`)
      .then(res => {
        if (!res.ok) { setRoomClosed(true); return null; }
        return res.json() as Promise<any>;
      })
      .then(data => {
        if (!data) return;
        if (data.Started) setPhase('playing');
        if (Array.isArray(data.Controllers)) {
          setControllers(data.Controllers.map((c: any) => ({
            id: c.Id ?? c.id,
            pseudo: c.Pseudo ?? c.pseudo,
            isConnected: c.IsConnected ?? c.isConnected,
          })));
        }
      })
      .catch(() => setRoomClosed(true));
  }, [roomId]);

  useEffect(() => {
    const cancel = onGamesStompConnect(() => {
      const client = getGamesStompClient();

      const sub = client.subscribe(`/topic/room/${roomId}`, (msg) => {
        const event = JSON.parse(msg.body) as Record<string, unknown>;

        if (event.type === 'input') {
          onInputRef.current?.(event as unknown as ControllerFrame);
          return;
        }

        const updatesControllers = (
          event.type === 'controller_joined' ||
          event.type === 'controller_reconnected' ||
          event.type === 'controller_disconnected' ||
          event.type === 'controller_ghosted'
        );
        if (updatesControllers && Array.isArray(event.controllers)) {
          setControllers((event.controllers as any[]).map((c: any) => ({
            id: c.Id ?? c.id,
            pseudo: c.Pseudo ?? c.pseudo,
            isConnected: c.IsConnected ?? c.isConnected,
          })));
        }

        if (event.type === 'game_started') setPhase('playing');
        if (event.type === 'room_closed') setRoomClosed(true);
      });

      return () => sub.unsubscribe();
    });

    return cancel;
  }, [roomId]);

  function start() {
    const client = getGamesStompClient();
    client.publish({
      destination: `/topic/room/${roomId}`,
      body: JSON.stringify({ type: 'game_started' }),
    });
    setPhase('playing');
  }

  return {
    roomUrl,
    controllers,
    controllerCount: controllers.filter(c => c.isConnected).length,
    phase,
    roomClosed,
    start,
  };
}
