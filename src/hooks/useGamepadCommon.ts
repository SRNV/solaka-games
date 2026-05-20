import { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import * as THREE from 'three';
import { getGamesStompClient, isGamesStompConnected } from '../gamesStompClient.ts';
import { THEMES, DEFAULT_THEME, type GamepadTheme } from '../components/gamepad3d/themes.ts';
import type { ControllerFrame } from '../types/inputs.ts';

export interface ThemeEntry extends GamepadTheme { type: 'theme'; }
export interface MatcapEntry { type: 'matcap'; id: string; name: string; path: string; outlineColor: string; }
export type NavEntry = ThemeEntry | MatcapEntry;

interface GamepadConfigJson {
  themes:  GamepadTheme[];
  matcaps: { id: string; name: string; path: string; outlineColor: string }[];
}

export function useGamepadCommon(roomId: string, controllerId: string, active: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [showSettings, setShowSettings] = useState(false);

  // ── Navigation state ────────────────────────────────────────
  const [configEntries, setConfigEntries] = useState<NavEntry[]>(() => {
    return THEMES.map(t => ({ type: 'theme' as const, ...t }));
  });

  const [navIndex, setNavIndex] = useState(() => {
    const saved = localStorage.getItem('gamepad_theme') || DEFAULT_THEME.id;
    const idx = THEMES.findIndex(t => t.id === saved);
    return idx >= 0 ? idx : 0;
  });

  const [matcapTexture, setMatcapTexture] = useState<THREE.Texture | null>(null);
  const [matcapLoading, setMatcapLoading] = useState(false);
  const loadSentinelRef = useRef<{ id: string; aborted: boolean } | null>(null);

  // ── Load config ─────────────────────────────────────────────
  useEffect(() => {
    fetch('/assets/gamepad-config.json')
      .then(r => r.json())
      .then((data: GamepadConfigJson) => {
        const entries: NavEntry[] = [
          ...data.themes.map(t => ({ type: 'theme'  as const, ...t })),
          ...data.matcaps.map(m => ({ type: 'matcap' as const, ...m })),
        ];
        setConfigEntries(entries);
        
        const saved = localStorage.getItem('gamepad_theme');
        if (saved) {
          const idx = entries.findIndex(e => e.id === saved);
          if (idx >= 0) setNavIndex(idx);
        }
      })
      .catch(() => {});
  }, []);

  const currentEntry: NavEntry = useMemo(() => {
    return configEntries[navIndex] ?? configEntries[0] ?? { type: 'theme' as const, ...DEFAULT_THEME };
  }, [configEntries, navIndex]);

  const theme = useMemo((): GamepadTheme => {
    if (currentEntry.type === 'theme') return currentEntry;
    return {
      ...DEFAULT_THEME,
      outlineColor: currentEntry.outlineColor || DEFAULT_THEME.outlineColor
    };
  }, [currentEntry]);

  // ── Matcap loading ──────────────────────────────────────────
  useEffect(() => {
    if (currentEntry.type !== 'matcap') {
      setMatcapTexture(null);
      setMatcapLoading(false);
      return;
    }
    if (loadSentinelRef.current) loadSentinelRef.current.aborted = true;
    const sentinel = { id: currentEntry.id, aborted: false };
    loadSentinelRef.current = sentinel;

    setMatcapLoading(true);
    new THREE.TextureLoader().load(currentEntry.path,
      tex => {
        if (sentinel.aborted) { tex.dispose(); return; }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        setMatcapTexture(tex);
        setMatcapLoading(false);
      },
      undefined,
      () => {
        if (!sentinel.aborted) {
          setMatcapTexture(null);
          setMatcapLoading(false);
        }
      }
    );
  }, [currentEntry]);

  // ── Viewport ────────────────────────────────────────────────
  useLayoutEffect(() => {
    const obs = new ResizeObserver(entries => {
      if (!entries[0]) return;
      const { width, height } = entries[0].contentRect;
      setVp({ w: width, h: height });
    });
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const isPortrait = vp.h > vp.w;
  const effectiveW = isPortrait ? vp.h : vp.w;
  const effectiveH = isPortrait ? vp.w : vp.h;

  // ── Actions ─────────────────────────────────────────────────
  const navigate = useCallback((dir: 1 | -1) => {
    setNavIndex(prev => {
      const next = Math.max(0, Math.min(configEntries.length - 1, prev + dir));
      localStorage.setItem('gamepad_theme', configEntries[next].id);
      return next;
    });
  }, [configEntries]);

  const publish = useCallback((frame: ControllerFrame) => {
    if (!active || !isGamesStompConnected()) return;
    getGamesStompClient().publish({
      destination: `/topic/room/${roomId}/input`,
      body: JSON.stringify(frame),
    });
  }, [roomId, active]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  const screenCoords = useCallback((e: React.PointerEvent): [number, number] => {
    if (!containerRef.current) return [0, 0];
    const rect = containerRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (isPortrait) return [effectiveW - sy, sx];
    return [sx, sy];
  }, [isPortrait, effectiveW]);

  return {
    containerRef, vp, isPortrait, effectiveW, effectiveH,
    showSettings, setShowSettings,
    configEntries, navIndex, navigate,
    currentEntry, theme, matcapTexture, matcapLoading,
    publish, toggleFullscreen, screenCoords
  };
}
