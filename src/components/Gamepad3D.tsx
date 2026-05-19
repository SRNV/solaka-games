import { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GamepadScene, GamepadSceneHandle } from './gamepad3d/GamepadScene.tsx';
import { GamepadBackground } from './gamepad3d/GamepadBackground.tsx';
import { computeZones, CAM_H } from './gamepad3d/useZones.ts';
import { useGamepadInput } from './gamepad3d/useGamepadInput.ts';
import { getGamesStompClient } from '../gamesStompClient.ts';
import { THEMES, DEFAULT_THEME, findTheme } from './gamepad3d/themes.ts';
import type { InputDescriptor, ControllerFrame } from '../types/inputs.ts';
import type { GamepadProps } from './Gamepad.tsx';
import styles from './Gamepad3D.module.css';

export interface Gamepad3DProps extends GamepadProps {
  inputs: InputDescriptor[];
}

function CameraAutoFit() {
  const { camera, size } = useThree();
  useLayoutEffect(() => {
    const cam = camera as THREE.OrthographicCamera;
    if (size.height === 0) return;
    const aspect = size.width / size.height;
    cam.top    =  CAM_H;
    cam.bottom = -CAM_H;
    cam.left   = -CAM_H * aspect;
    cam.right  =  CAM_H * aspect;
    cam.updateProjectionMatrix();
  }, [camera, size]);
  return null;
}

export function Gamepad3D({ roomId, controllerId, inputs, active = true }: Gamepad3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<GamepadSceneHandle>(null);
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [themeId, setThemeId] = useState(() => localStorage.getItem('gamepad_theme') || DEFAULT_THEME.id);
  const [showSettings, setShowSettings] = useState(false);
  const [, setTick] = useState(0);
  
  const theme = useMemo(() => findTheme(themeId), [themeId]);

  useLayoutEffect(() => {
    const obs = new ResizeObserver(entries => {
      if (!entries[0]) return;
      const { width, height } = entries[0].contentRect;
      setVp({ w: width, h: height });
    });
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const zones = useMemo(() => computeZones(vp.w, vp.h, inputs, theme), [vp.w, vp.h, inputs, theme]);
  const zonesRef = useRef(zones);
  zonesRef.current = zones;

  const publish = useCallback((patches: any[]) => {
    if (!active) return;
    const client = getGamesStompClient();
    if (!client.connected) return;
    
    const frame: ControllerFrame = {
      t: Date.now(),
      patches
    };

    client.publish({
      destination: `/topic/room/${roomId}/input`,
      body: JSON.stringify(frame),
    });
  }, [roomId, active]);

  const onButtonDown = useCallback((zone: any) => {
    sceneRef.current?.triggerExplosion(zone.wx, zone.wy, zone.color, zone.id);
  }, []);

  const input = useGamepadInput(zonesRef, controllerId, publish, onButtonDown, () => setTick(t => t + 1));

  // Background reactivity
  const bgState = useMemo(() => {
    const js = zones.find(z => z.inputType === 'joystick');
    const joystick = js ? input.getAxis(js.id) : { x: 0, y: 0 };
    const isPressed = zones.some(z => input.isPressed(z.id));
    return { joystick, isPressed };
  }, [zones, input, vp]); // Recompute when viewport changes too

  function screenCoords(e: React.PointerEvent): [number, number] {
    const rect = containerRef.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  function onPointerDown(e: React.PointerEvent) {
    if (showSettings) return;
    containerRef.current?.setPointerCapture(e.pointerId);
    const [cx, cy] = screenCoords(e);
    input.handleDown(e.pointerId, cx, cy);
  }

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable full-screen mode: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  };

  const handleThemeChange = (id: string) => {
    setThemeId(id);
    localStorage.setItem('gamepad_theme', id);
  };

  return (
    <div
      ref={containerRef}
      className={styles.container}
      style={{ backgroundColor: theme.bg }}
      onPointerDown={onPointerDown}
      onPointerMove={e => !showSettings && input.handleMove(e.pointerId, ...screenCoords(e))}
      onPointerUp={e => {
        input.handleUp(e.pointerId);
        try { containerRef.current?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      }}
      onPointerCancel={e => input.handleUp(e.pointerId)}
    >

      <Canvas
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        orthographic
        camera={{ position: [0, 0, 10], near: 0.1, far: 100 }}
        gl={{ antialias: true, alpha: true }}
      >
        <CameraAutoFit />
        <GamepadScene ref={sceneRef} zones={zones} input={input} theme={theme} />
      </Canvas>

      {/* HTML Labels */}
      {zones.filter(z => z.label).map(zone => (
        <div
          key={zone.id}
          className={styles.label}
          style={{
            left: zone.cx,
            top: zone.cy,
            fontSize: Math.max(Math.round(zone.hitRadius * 0.38), 11),
            color: 'white',
          }}
        >
          {zone.label}
        </div>
      ))}

      {/* Settings Icon */}
      <button 
        className={styles.settingsBtn} 
        onClick={() => setShowSettings(!showSettings)}
      >
        ⚙️
      </button>

      {/* Fullscreen Icon */}
      <button 
        className={styles.fullscreenBtn} 
        onClick={toggleFullscreen}
      >
        ⛶
      </button>

      {/* Waiting Indicator */}
      {!active && (
        <div className={styles.waitingBanner}>
          En attente du démarrage...
        </div>
      )}

      {/* Theme Overlay */}
      {showSettings && (
        <div className={styles.overlay} onClick={() => setShowSettings(false)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <h3>Personnalisation</h3>
            <div className={styles.themeGrid}>
              {THEMES.map(t => (
                <button 
                  key={t.id} 
                  className={`${styles.themeOption} ${t.id === themeId ? styles.active : ''}`}
                  style={{ '--theme-color': t.joystick } as any}
                  onClick={() => handleThemeChange(t.id)}
                >
                  {t.name}
                </button>
              ))}
            </div>
            <button className={styles.closeBtn} onClick={() => setShowSettings(false)}>Fermer</button>
          </div>
        </div>
      )}
    </div>
  );
}
