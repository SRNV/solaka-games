import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { SvgGamepadScene, type SvgGamepadSceneHandle } from './svgGamepad/SvgGamepadScene.tsx';
import { useSvgZones } from '../hooks/useSvgZones.ts';
import { computeZones, CAM_H } from './gamepad3d/useZones.ts';
import { useGamepadInput } from './gamepad3d/useGamepadInput.ts';
import { useGamepadCommon } from '../hooks/useGamepadCommon.ts';
import { GamepadOverlay, SettingsModal } from './GamepadSharedUI.tsx';
import type { InputDescriptor } from '../types/inputs.ts';
import type { GamepadProps } from './Gamepad.tsx';
import styles from './Gamepad3D.module.css';

export interface Gamepad3DProps extends GamepadProps {
  inputs?: InputDescriptor[];
  svgUrl?: string;
}

function CameraAutoFit() {
  const { camera, size } = useThree();
  useLayoutEffect(() => {
    if (size.height === 0) return;
    const cam    = camera as THREE.OrthographicCamera;
    const aspect = size.width / size.height;
    cam.top    =  CAM_H;
    cam.bottom = -CAM_H;
    cam.left   = -CAM_H * aspect;
    cam.right  =  CAM_H * aspect;
    cam.updateProjectionMatrix();
  }, [camera, size]);
  return null;
}

export function Gamepad3D({ roomId, controllerId, inputs = [], svgUrl, active = true, isMaster }: Gamepad3DProps) {
  const sceneRef    = useRef<SvgGamepadSceneHandle>(null);

  const {
    containerRef, vp, isPortrait, effectiveW, effectiveH,
    showSettings, setShowSettings,
    configEntries, navIndex, navigate,
    currentEntry, theme, matcapTexture, matcapLoading,
    publish, toggleFullscreen, screenCoords
  } = useGamepadCommon(roomId, controllerId, active);

  // ── Layout Logic ────────────────────────────────────────────
  
  // 1. SVG-based layout
  const svgData = useSvgZones(
    svgUrl ?? '', 
    effectiveW, effectiveH, 
    inputs, 
    theme,
  );

  // 2. Standard 3D layout (fallback or if no svgUrl)
  const fallbackZones = useMemo(() => 
    computeZones(effectiveW, effectiveH, inputs, theme), 
    [effectiveW, effectiveH, inputs, theme]
  );

  const isSvg = !!svgUrl && !svgData.error;
  const zones = isSvg ? (svgData.zones.length ? svgData.zones : svgData.fallbackZones) : fallbackZones;
  
  const zonesRef = useRef(zones);
  zonesRef.current = zones;

  const viewportCenter = useMemo(() => {
    if (!isSvg || !svgData.viewport) return undefined;
    return { x: svgData.viewport.x + svgData.viewport.w / 2, y: svgData.viewport.y + svgData.viewport.h / 2 };
  }, [isSvg, svgData.viewport]);

  // ── Input Handling ──────────────────────────────────────────

  const onButtonDown = (zone: any, cx: number, cy: number) => {
    const nx     = cx / vp.w;
    const ny     = cy / vp.h;
    const aspect = vp.w / vp.h;
    const wx     = (nx * 2 - 1) * CAM_H * aspect;
    const wy     = (1 - ny * 2) * CAM_H;
    sceneRef.current?.triggerExplosion(wx, wy, zone.color, zone.id);
  };

  const findZoneOverride = (cx: number, cy: number) => {
    return sceneRef.current?.hitTest(cx, cy) ?? null;
  };

  const input = useGamepadInput(
    zonesRef, 
    controllerId, 
    publish, 
    onButtonDown, 
    undefined, 
    isSvg ? findZoneOverride : undefined
  );

  function onPointerDown(e: React.PointerEvent) {
    if (showSettings) return;
    containerRef.current?.setPointerCapture(e.pointerId);
    const [cx, cy] = screenCoords(e);
    input.handleDown(e.pointerId, cx, cy);
  }

  return (
    <div
      ref={containerRef}
      className={styles.container}
      style={{ backgroundColor: theme.bg, overflow: isPortrait ? 'visible' : 'hidden' }}
      onPointerDown={onPointerDown}
      onPointerMove={e => !showSettings && input.handleMove(e.pointerId, ...screenCoords(e))}
      onPointerUp={e => {
        input.handleUp(e.pointerId);
        try { containerRef.current?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      }}
      onPointerCancel={e => input.handleUp(e.pointerId)}
    >
      <GamepadOverlay active={active} theme={theme} loading={(isSvg && svgData.loading) || matcapLoading} />

      {isSvg && svgData.error && (
        <div className={styles.waitingBanner} style={{ 
          fontSize: '0.8rem', 
          color: '#ffffff', 
          backgroundColor: '#e05555',
          padding: '4px 12px',
          borderRadius: '4px',
          fontWeight: 'bold',
          boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
          zIndex: 1000
        }}>
          ⚠️ {svgData.error}
        </div>
      )}

      <div style={isPortrait ? {
        position: 'absolute',
        width: effectiveW,
        height: effectiveH,
        left: (vp.w - effectiveW) / 2,
        top:  (vp.h - effectiveH) / 2,
        transform: 'rotate(-90deg)',
        transformOrigin: 'center center',
      } : {
        position: 'absolute',
        inset: 0,
      }}>
        <Canvas
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          orthographic
          camera={{ position: [0, 0, 10], near: 0.1, far: 100 }}
          gl={{ antialias: true, alpha: false }}
        >
          <CameraAutoFit />
          <SvgGamepadScene
            ref={sceneRef}
            zones={zones}
            input={input}
            theme={theme}
            svgToWorldMatrix={isSvg ? svgData.svgToWorldMatrix : new THREE.Matrix4()}
            viewportCenter={viewportCenter}
            matcapTexture={matcapTexture}
            outlineColor={theme.outlineColor}
            isStandalone={!isSvg}
          />
        </Canvas>

        {zones.filter(z => z.label).map(zone => (
          <div
            key={zone.id}
            className={styles.label}
            style={{
              left: zone.cx,
              top:  zone.cy,
              fontSize: Math.max(Math.round(zone.hitRadius * 0.38), 11),
              color: 'white',
              pointerEvents: 'none',
            }}
          >
            {zone.label}
          </div>
        ))}
      </div>

      <button className={styles.settingsBtn}   onClick={() => setShowSettings(!showSettings)}>⚙️</button>
      <button className={styles.fullscreenBtn} onClick={toggleFullscreen}>⛶</button>

      {isMaster && (
        <div 
          className={styles.masterIndicator} 
          title="Vous êtes le maître de la partie"
          style={{ backgroundColor: '#4CAF50' }}
        />
      )}

      <SettingsModal 
        show={showSettings}
        onClose={() => setShowSettings(false)}
        navIndex={navIndex}
        configEntries={configEntries}
        currentEntry={currentEntry}
        onNavigate={navigate}
      />
    </div>
  );
}
