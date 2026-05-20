import { useEffect, useRef, useState, useCallback } from 'react';
import { getGamesStompClient, onGamesStompConnect, onGamesStompDisconnect } from '../gamesStompClient.ts';
import { randomUUID } from '../uuid.ts';

export type ControllerPhase = 'waiting' | 'playing';
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export interface UseControllerRoomResult {
  phase: ControllerPhase;
  status: ConnectionStatus;
  registered: boolean;
  error: string | null;
  controllerId: string;
  isMaster: boolean;
  clearError: () => void;
}

const CTRL_ID_PREFIX = 'gamepad_ctrl_';
const PING_INTERVAL_MS = 12_000;

function getOrCreateControllerId(roomId: string): string {
  const key = `${CTRL_ID_PREFIX}${roomId}`;
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return randomUUID();
  }
}

export function useControllerRoom(
  roomId: string,
  pseudo: string,
  pseudoConfirmed: boolean,
): UseControllerRoomResult {
  const controllerId = useRef(getOrCreateControllerId(roomId)).current;
  const [phase, setPhase] = useState<ControllerPhase>('waiting');
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [registered, setRegistered] = useState(false);
  const [isMaster, setIsMaster] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pseudoRef = useRef(pseudo);
  pseudoRef.current = pseudo;

  function stopPing() {
    if (pingTimer.current) {
      clearInterval(pingTimer.current);
      pingTimer.current = null;
    }
  }

  function startPing() {
    stopPing();
    pingTimer.current = setInterval(() => {
      const client = getGamesStompClient();
      if (client.connected) {
        client.publish({
          destination: '/app/ping',
          body: JSON.stringify({ roomId, controllerId }),
        });
      }
    }, PING_INTERVAL_MS);
  }

  const register = useCallback(async () => {
    try {
      const res = await fetch(`/games-api/api/rooms/${roomId}/controllers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ controllerId, pseudo: pseudoRef.current }),
      });

      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        setError((body as any).message ?? 'Pseudo déjà utilisé dans cette partie.');
        return;
      }
      if (!res.ok) {
        setError('Partie introuvable ou terminée.');
        return;
      }

      setRegistered(true);
      setError(null);

      // Extract current room phase from registration response
      const body = await res.json().catch(() => ({}));
      if (body.phase === 'playing') {
        setPhase('playing');
      } else if (body.phase === 'waiting') {
        setPhase('waiting');
      }

      if (Array.isArray(body.Controllers)) {
        const connected = body.Controllers.filter((c: any) => c.IsConnected ?? c.isConnected);
        setIsMaster(connected[0]?.Id === controllerId || connected[0]?.id === controllerId);
      }

      // Link this STOMP session so the server detects disconnects
      const client = getGamesStompClient();
      if (client.connected) {
        client.publish({
          destination: '/app/register',
          body: JSON.stringify({ roomId, controllerId }),
        });
      }
    } catch {
      setError('Impossible de rejoindre la partie. Vérifiez votre connexion.');
    }
  }, [roomId, controllerId]);

  useEffect(() => {
    if (!pseudoConfirmed) return;

    // Initial HTTP registration
    register();

    // STOMP — re-subscribed automatically on every (re)connect by onGamesStompConnect
    const cancelConnect = onGamesStompConnect(async () => {
      setStatus('connected');
      
      // Re-register via HTTP if needed, to ensure the server knows our pseudo/id
      // before we link the STOMP session.
      await register();

      const client = getGamesStompClient();

      // Re-link session after reconnect
      client.publish({
        destination: '/app/register',
        body: JSON.stringify({ roomId, controllerId }),
      });

      const sub = client.subscribe(`/topic/room/${roomId}`, (msg) => {
        const event = JSON.parse(msg.body) as Record<string, unknown>;
        if (event.type === 'game_started') setPhase('playing');
        if (event.type === 'room_closed') setError('La partie a été fermée par le serveur.');

        const updatesControllers = (
          event.type === 'controller_joined' ||
          event.type === 'controller_reconnected' ||
          event.type === 'controller_disconnected' ||
          event.type === 'controller_ghosted'
        );
        if (updatesControllers && Array.isArray(event.controllers)) {
          const connected = event.controllers.filter((c: any) => c.isConnected);
          setIsMaster(connected[0]?.id === controllerId);
        }
      });

      startPing();

      return () => {
        sub.unsubscribe();
        stopPing();
      };
    });

    const cancelDisconnect = onGamesStompDisconnect(() => {
      setStatus('reconnecting');
    });

    return () => {
      cancelConnect();
      cancelDisconnect();
      stopPing();
    };
  }, [roomId, pseudoConfirmed]);

  return {
    phase,
    status,
    registered,
    error,
    controllerId,
    isMaster,
    clearError: () => setError(null),
  };
}
