import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { parseSvg, normalizeToViewport, type SvgRect, type ParsedSvg } from '../utils/svgParser.ts';
import { computeZones, CAM_H, type Zone } from '../components/gamepad3d/useZones.ts';
import type { InputDescriptor } from '../types/inputs.ts';
import type { GamepadTheme } from '../components/gamepad3d/themes.ts';

export type SvgViewBox = SvgRect;

export interface SvgZoneExtra {
  pathD: string | null;
  /** Normalized [0..1] coords relative to viewport (may exceed bounds for hors-champ) */
  nx: number;
  ny: number;
  nr: number;
  /** Center and radius in SVG coordinate space (for fallback ring + joystick offset) */
  svgCx: number;
  svgCy: number;
  svgRadius: number;
  /** Normalized bounding box [0..1] */
  nBBox: SvgRect;
  /** Bounding box in container pixels */
  pixelBBox: SvgRect;
}

export interface SvgZone extends Zone {
  svgExtra: SvgZoneExtra;
}

export interface UseSvgZonesResult {
  zones: SvgZone[];
  viewport: SvgRect | null;
  viewBox: SvgViewBox | null;
  /** Matrix4 mapping SVG coordinates → R3F world space */
  svgToWorldMatrix: THREE.Matrix4;
  loading: boolean;
  error: string | null;
  fallbackZones: Zone[];
}

/**
 * Builds a Matrix4 that maps SVG coordinates → Three.js world space.
 * SVG: top-left origin, Y down. Three.js: center origin, Y up.
 * The viewport rect fills the camera frustum exactly.
 */
function buildSvgToWorld(viewport: SvgRect, vpW: number, vpH: number): THREE.Matrix4 {
  const aspect = vpW / vpH;
  const scaleX =  (2 * CAM_H * aspect) / viewport.w;
  const scaleY = -(2 * CAM_H)          / viewport.h;
  const offX   = -CAM_H * aspect - viewport.x * scaleX;
  const offY   =  CAM_H           - viewport.y * scaleY;
  const m = new THREE.Matrix4();
  m.set(
    scaleX, 0, 0, offX,
    0, scaleY, 0, offY,
    0, 0, 1, 0,
    0, 0, 0, 1,
  );
  return m;
}

const IDENTITY = new THREE.Matrix4();

function buildZones(
  parsed: ParsedSvg,
  vpW: number,
  vpH: number,
  descriptors: InputDescriptor[],
  theme: GamepadTheme,
): SvgZone[] {
  const { viewport, elements } = parsed;
  const result: SvgZone[] = [];

  for (const elem of elements) {
    // Regex rule: (type[:slot])name
    // Examples: (joystick)stickL, (button:diamond-right)A, (boolean:center)L
    const match = elem.id.match(/^\(([^)]+)\)(.*)$/);
    const fullType = match ? match[1].toLowerCase() : 'button';
    const name     = match ? match[2] : elem.id;

    const [typeStr, slot] = fullType.split(':');

    // Also strip prefix from zoneKey for communication
    const keyMatch = elem.zoneKey.match(/^\(([^)]+)\)(.*)$/);
    const cleanZoneKey = keyMatch ? keyMatch[2] : elem.zoneKey;

    const descriptor = descriptors.find(d => d.id.toLowerCase() === name.toLowerCase());
    
    // Check if it's a joystick based on (joystick) prefix or descriptor type
    const isJoystick = typeStr === 'joystick' || (descriptor?.type === 'axis2d');

    const effectiveSlot = slot || descriptor?.slot;
    const isBoolean = typeStr === 'boolean' || (descriptor ? descriptor.type === 'boolean' : true);

    const { nx, ny, nr } = normalizeToViewport(elem.cx, elem.cy, elem.radius, viewport);
    const nBBox = {
      x: (elem.bbox.x - viewport.x) / viewport.w,
      y: (elem.bbox.y - viewport.y) / viewport.h,
      w: elem.bbox.w / viewport.w,
      h: elem.bbox.h / viewport.h,
    };
    const pixelBBox = {
      x: nBBox.x * vpW,
      y: nBBox.y * vpH,
      w: nBBox.w * vpW,
      h: nBBox.h * vpH,
    };

    const cx = nx * vpW;
    const cy = ny * vpH;
    const hitRadius = nr * Math.min(vpW, vpH);

    // World-space center (for explosion trigger position + fallback ring wx/wy)
    const aspect = vpW / vpH;
    const wx = (nx * 2 - 1) * CAM_H * aspect;
    const wy = (1 - ny * 2) * CAM_H;
    const wRadius = nr * 2 * CAM_H;

    const color =
      descriptor?.color ??
      (isJoystick
        ? theme.joystick
        : effectiveSlot === 'diamond-right'  ? theme.btnA
        : effectiveSlot === 'diamond-bottom' ? theme.btnB
        : effectiveSlot === 'center'         ? theme.btnCenter
        : theme.btnXY);

    // Hide labels for joysticks as requested
    const label = isJoystick ? undefined : (descriptor ? (descriptor as any).label : name);

    result.push({
      id: name,
      zoneKey: cleanZoneKey,
      inputType: isJoystick ? 'joystick' : 'button',
      isBoolean,
      cx,
      cy,
      hitRadius,
      wx,
      wy,
      wRadius,
      label,
      color,
      slot: effectiveSlot,
      svgExtra: {
        pathD:     elem.pathD,
        nx, ny, nr,
        svgCx:     elem.cx,
        svgCy:     elem.cy,
        svgRadius: elem.radius,
        nBBox,
        pixelBBox,
      },
    });
  }

  return result;
}

export function useSvgZones(
  svgUrl: string | null,
  vpW: number,
  vpH: number,
  descriptors: InputDescriptor[],
  theme: GamepadTheme,
): UseSvgZonesResult {
  const [parsed, setParsed]   = useState<ParsedSvg | null>(null);
  const [loading, setLoading] = useState(!!svgUrl);
  const [error, setError]     = useState<string | null>(null);

  const fallbackZones = computeZones(vpW, vpH, descriptors, theme);

  // Fetch + parse SVG only when URL / descriptors / theme change (not on resize)
  useEffect(() => {
    if (!svgUrl) { setParsed(null); setLoading(false); return; }
    setLoading(true);

    fetch(svgUrl)
      .then(r => { if (!r.ok) throw new Error(`SVG not found: ${svgUrl}`); return r.text(); })
      .then(svgText => {
        setParsed(parseSvg(svgText)); // Dynamic: fetch all elements with IDs
        setError(null);
      })
      .catch(e => {
        setError((e as Error).message);
        setParsed(null);
      })
      .finally(() => setLoading(false));
  }, [svgUrl]);

  // Recompute zones + matrix whenever parsed data or viewport size changes
  const { zones, error: logicError } = useMemo(
    () => {
      if (!parsed || vpW <= 0 || vpH <= 0) return { zones: [], error: null };
      const z = buildZones(parsed, vpW, vpH, descriptors, theme);
      
      // Check for duplicate names (nonconforming)
      const names = z.map(x => x.id);
      const dups = names.filter((n, i) => names.indexOf(n) !== i);
      const uniqueDups = Array.from(new Set(dups));
      
      const error = uniqueDups.length > 0 
        ? `Manette non conforme : noms en double (${uniqueDups.join(', ')})` 
        : null;

      return { zones: z, error };
    },
    [parsed, vpW, vpH, descriptors, theme],
  );

  const svgToWorldMatrix = useMemo(
    () => parsed && vpW > 0 && vpH > 0
      ? buildSvgToWorld(parsed.viewport, vpW, vpH)
      : IDENTITY,
    [parsed, vpW, vpH],
  );

  return {
    zones,
    viewport:        parsed?.viewport ?? null,
    viewBox:         parsed?.viewBox  ?? null,
    svgToWorldMatrix,
    loading,
    error:           error || logicError,
    fallbackZones,
  };
}
