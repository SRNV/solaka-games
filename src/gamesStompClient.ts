import { Client } from '@stomp/stompjs';

let _client: Client | null = null;

// Persistent connect listeners — called on every (re)connect
// Returns optional cleanup called before next reconnect or on deregister
type ConnectListener = () => (() => void) | void;
const _connectListeners = new Map<symbol, { cb: ConnectListener; cleanup?: () => void }>();

// Disconnect listeners — called when WebSocket closes (before reconnect attempt)
const _disconnectListeners = new Set<() => void>();

function buildClient(): Client {
  const brokerURL = import.meta.env.VITE_GAMES_STOMP_URL
    || `ws://${window.location.hostname}:5000/stomp`;

  const client = new Client({
    brokerURL,
    reconnectDelay: 3000,
    heartbeatIncoming: 15000,
    heartbeatOutgoing: 15000,
    debug: (str) => console.debug('[GAMES STOMP]', str),
  });

  client.onConnect = () => {
    for (const entry of _connectListeners.values()) {
      // Clean previous subscription before re-subscribing on reconnect
      entry.cleanup?.();
      const result = entry.cb();
      entry.cleanup = result ?? undefined;
    }
  };

  client.onWebSocketClose = () => {
    // Run per-listener cleanups (subscriptions are dead after disconnect)
    for (const entry of _connectListeners.values()) {
      entry.cleanup?.();
      entry.cleanup = undefined;
    }
    _disconnectListeners.forEach(cb => cb());
  };

  client.onStompError = (frame) => {
    console.error('[GAMES STOMP] STOMP error:', frame.headers['message']);
  };

  client.activate();
  return client;
}

export function getGamesStompClient(): Client {
  if (!_client) _client = buildClient();
  return _client;
}

/**
 * Register a callback that runs every time the STOMP client connects (including reconnects).
 * The callback may return a cleanup function (e.g. unsubscribe) that runs before the next
 * reconnect or when the registration is cancelled.
 *
 * Returns a cancellation function — call it when the component unmounts.
 */
export function onGamesStompConnect(cb: ConnectListener): () => void {
  const client = getGamesStompClient();
  const key = Symbol();
  const entry: { cb: ConnectListener; cleanup?: () => void } = { cb };
  _connectListeners.set(key, entry);

  if (client.connected) {
    const result = cb();
    entry.cleanup = result ?? undefined;
  }

  return () => {
    entry.cleanup?.();
    _connectListeners.delete(key);
  };
}

/**
 * Register a callback fired when the WebSocket disconnects (before auto-reconnect).
 * Returns a cancellation function.
 */
export function onGamesStompDisconnect(cb: () => void): () => void {
  _disconnectListeners.add(cb);
  return () => _disconnectListeners.delete(cb);
}

export function isGamesStompConnected(): boolean {
  return _client?.connected ?? false;
}

export function forceGamesStompReconnect(): void {
  if (_client) {
    console.debug('[GAMES STOMP] Forcing manual reconnect...');
    _client.deactivate().then(() => {
      _client?.activate();
    });
  } else {
    getGamesStompClient();
  }
}
