import { Client } from '@stomp/stompjs';

let _client: Client | null = null;
const _connectQueue: Array<() => void> = [];

export function getGamesStompClient(): Client {
  if (_client) return _client;

  // Use explicit env var (for production/custom deploy), otherwise connect directly to
  // games-server port 5000 using the current hostname — works for both localhost and LAN IP.
  const brokerURL = import.meta.env.VITE_GAMES_STOMP_URL || `ws://${window.location.hostname}:5000/stomp`;
  _client = new Client({
    brokerURL,
    reconnectDelay: 3000,
    debug: (str) => console.debug('[GAMES STOMP]', str),
  });
  _client.onConnect = () => {
    _connectQueue.splice(0).forEach(cb => cb());
  };
  _client.activate();
  return _client;
}

export function onGamesStompConnect(cb: () => void): () => void {
  const client = getGamesStompClient();
  if (client.connected) {
    cb();
    return () => {};
  }
  _connectQueue.push(cb);
  return () => {
    const i = _connectQueue.indexOf(cb);
    if (i !== -1) _connectQueue.splice(i, 1);
  };
}
