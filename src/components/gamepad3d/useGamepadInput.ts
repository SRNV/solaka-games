import { useRef } from 'react';
import type { Zone } from './useZones.ts';
import type { InputPatch, Axis2DValue, ButtonValue, BooleanValue, ControllerFrame } from '../../types/inputs.ts';

interface ActiveAxis   { zoneId: string; zoneKey: string; baseCx: number; baseCy: number; hitRadius: number }
interface ActiveButton { zoneId: string; zoneKey: string; pressedAt: number; isBoolean: boolean }

export function useGamepadInput(
  zonesRef: React.RefObject<Zone[]>,
  controllerId: string,
  publish: (frame: ControllerFrame) => void,
  onButtonDown?: (zone: Zone, cx: number, cy: number) => void,
  onInput?: () => void,
  findZoneOverride?: (cx: number, cy: number) => string | null,
) {
  const activeAxes    = useRef<Map<number, ActiveAxis>>(new Map());
  const activeButtons = useRef<Map<number, ActiveButton>>(new Map());
  const axisValues    = useRef<Map<string, { x: number; y: number }>>(new Map());
  const btnPressed    = useRef<Map<string, boolean>>(new Map());

  const lastPublishAt = useRef<number>(0);
  const pendingPatches = useRef<InputPatch[]>([]);

  function findZone(cx: number, cy: number): Zone | null {
    if (findZoneOverride) {
      const zoneKey = findZoneOverride(cx, cy);
      if (zoneKey) {
        return zonesRef.current?.find(z => z.zoneKey === zoneKey) ?? null;
      }
    }

    let best: Zone | null = null;
    let bestDist = Infinity;
    for (const z of (zonesRef.current ?? [])) {
      const sz = z as any;
      if (sz.svgExtra?.pixelBBox && z.inputType !== 'joystick') {
        const { x, y, w, h } = sz.svgExtra.pixelBBox;
        if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) {
          return z; 
        }
      }

      const d = Math.hypot(cx - z.cx, cy - z.cy);
      if (d <= z.hitRadius && d < bestDist) { best = z; bestDist = d; }
    }
    return best;
  }

  function publishThrottled(patches: InputPatch[], force: boolean = false) {
    pendingPatches.current.push(...patches);
    
    const now = Date.now();
    const shouldPublish = force || (now - lastPublishAt.current >= 16); // ~60fps throttle

    if (shouldPublish && pendingPatches.current.length > 0) {
      publish({ t: now, patches: pendingPatches.current });
      pendingPatches.current = [];
      lastPublishAt.current = now;
    }
  }

  function handleDown(pointerId: number, cx: number, cy: number) {
    const zone = findZone(cx, cy);
    if (!zone) return;
    const patches: InputPatch[] = [];

    if (zone.inputType === 'joystick') {
      if (navigator.vibrate) navigator.vibrate([30]); // Array syntax
      // Pour les joysticks, on définit le centre de l'axe au moment du premier touché
      // pour éviter le "saut" si on ne touche pas exactement le centre visuel.
      activeAxes.current.set(pointerId, { 
        zoneId: zone.id, 
        zoneKey: zone.zoneKey, 
        baseCx: cx, 
        baseCy: cy, 
        hitRadius: zone.hitRadius 
      });
      axisValues.current.set(zone.zoneKey, { x: 0, y: 0 });
      btnPressed.current.set(zone.zoneKey, true);
      patches.push({ controllerId, id: zone.id, zoneKey: zone.zoneKey, value: { type: 'axis2d', x: 0, y: 0 } });
      publishThrottled(patches);
    } else {
      if (!btnPressed.current.get(zone.zoneKey)) {
        if (navigator.vibrate) navigator.vibrate([50]); // Array syntax
        onButtonDown?.(zone, cx, cy);
        activeButtons.current.set(pointerId, { zoneId: zone.id, zoneKey: zone.zoneKey, pressedAt: Date.now(), isBoolean: zone.isBoolean });
        btnPressed.current.set(zone.zoneKey, true);
        const value: ButtonValue | BooleanValue = zone.isBoolean
          ? { type: 'boolean', pressed: true }
          : { type: 'button',  pressed: true, duration: 0 };
        patches.push({ controllerId, id: zone.id, zoneKey: zone.zoneKey, value });
        publishThrottled(patches, true); // Buttons are FORCED (instant)
      }
    }
    onInput?.();
  }

  function handleMove(pointerId: number, cx: number, cy: number) {
    const a = activeAxes.current.get(pointerId);
    if (!a) return;
    const dx = cx - a.baseCx;
    const dy = cy - a.baseCy;
    const dist = Math.hypot(dx, dy);
    const maxTravel = a.hitRadius * 0.65;
    const clamp = Math.min(dist, maxTravel);
    const nx = dist > 2 ? Math.round((dx / dist) * (clamp / maxTravel) * 100) / 100 : 0;
    // Inverting Y to match World Space (Up is Positive) vs Screen Space (Down is Positive)
    const ny = dist > 2 ? Math.round(-(dy / dist) * (clamp / maxTravel) * 100) / 100 : 0;
    const prev = axisValues.current.get(a.zoneKey);
    if (prev?.x === nx && prev?.y === ny) return;
    axisValues.current.set(a.zoneKey, { x: nx, y: ny });
    publishThrottled([{ controllerId, id: a.zoneId, zoneKey: a.zoneKey, value: { type: 'axis2d', x: nx, y: ny } as Axis2DValue }]);
    onInput?.();
  }

  function handleUp(pointerId: number) {
    const patches: InputPatch[] = [];
    const a = activeAxes.current.get(pointerId);
    let force = false;

    if (a) {
      activeAxes.current.delete(pointerId);
      axisValues.current.delete(a.zoneKey);
      btnPressed.current.delete(a.zoneKey);
      patches.push({ controllerId, id: a.zoneId, zoneKey: a.zoneKey, value: { type: 'axis2d', x: 0, y: 0 } as Axis2DValue });
    }
    const b = activeButtons.current.get(pointerId);
    if (b) {
      activeButtons.current.delete(pointerId);
      btnPressed.current.delete(b.zoneKey);
      const value: ButtonValue | BooleanValue = b.isBoolean
        ? { type: 'boolean', pressed: false }
        : { type: 'button',  pressed: false, duration: Date.now() - b.pressedAt };
      patches.push({ controllerId, id: b.zoneId, zoneKey: b.zoneKey, value });
      force = true; // Button release is critical
    }
    if (patches.length) publishThrottled(patches, force);
    onInput?.();
  }

  function getAxis(id: string) { return axisValues.current.get(id) ?? { x: 0, y: 0 }; }
  function isPressed(id: string) { return btnPressed.current.get(id) ?? false; }

  return { handleDown, handleMove, handleUp, getAxis, isPressed };
}

export type GamepadInputHandle = ReturnType<typeof useGamepadInput>;
