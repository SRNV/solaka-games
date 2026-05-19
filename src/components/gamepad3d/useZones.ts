import type { InputDescriptor, Axis2DDescriptor, ButtonDescriptor, BooleanDescriptor } from '../../types/inputs.ts';
import type { GamepadTheme } from './themes.ts';

export const CAM_H = 5; // orthographic camera half-height (world units)

export interface Zone {
  id: string;
  inputType: 'joystick' | 'button';
  isBoolean: boolean; // true → emit BooleanValue (no duration)
  // screen-space (px) — touch hit testing
  cx: number;
  cy: number;
  hitRadius: number;
  // world-space — 3D mesh positioning
  wx: number;
  wy: number;
  wRadius: number;
  // metadata
  label?: string;
  color: string;
  slot?: ButtonDescriptor['slot'];
}

function toWorld(cx: number, cy: number, vpW: number, vpH: number): [number, number] {
  const aspect = vpW / vpH;
  return [
    ((cx / vpW) * 2 - 1) * CAM_H * aspect,
    (1 - (cy / vpH) * 2) * CAM_H,
  ];
}

function pxToWu(px: number, vpH: number): number {
  return px * (2 * CAM_H / vpH);
}

type ButtonLike = ButtonDescriptor | BooleanDescriptor;

function isButtonLike(d: InputDescriptor): d is ButtonLike {
  return d.type === 'button' || d.type === 'boolean';
}

function slotThemeColor(slot: ButtonDescriptor['slot'], theme: GamepadTheme): string {
  switch (slot) {
    case 'diamond-right':  return theme.btnA;
    case 'diamond-bottom': return theme.btnB;
    case 'diamond-top':
    case 'diamond-left':   return theme.btnXY;
    case 'center':         return theme.btnCenter;
  }
}

export function computeZones(vpW: number, vpH: number, descriptors: InputDescriptor[], theme: GamepadTheme): Zone[] {
  if (vpW === 0 || vpH === 0) return [];

  const portrait = vpH > vpW;
  const vmin     = Math.min(vpW, vpH);

  const axisDefs   = descriptors.filter((d): d is Axis2DDescriptor => d.type === 'axis2d');
  const btnDefs    = descriptors.filter(isButtonLike);

  const zones: Zone[] = [];

  // ── Joysticks ─────────────────────────────────────────────────
  const jsHit  = vmin * 0.24;
  const jsVisu = vmin * 0.18;

  axisDefs.forEach(d => {
    let cx: number, cy: number;
    if (portrait) {
      cx = d.slot === 'left' ? vpW * 0.27 : vpW * 0.73;
      cy = vpH * 0.30;
    } else {
      cx = d.slot === 'left' ? vpW * 0.18 : vpW * 0.82;
      cy = vpH * 0.50;
    }
    const [wx, wy] = toWorld(cx, cy, vpW, vpH);
    zones.push({
      id: d.id, inputType: 'joystick', isBoolean: false,
      cx, cy, hitRadius: jsHit,
      wx, wy, wRadius: pxToWu(jsVisu, vpH),
      color: d.color ?? theme.joystick,
    });
  });

  // ── Diamond buttons ───────────────────────────────────────────
  const btnHit  = vmin * 0.12;
  const btnVisu = vmin * 0.085;
  const spacing = vmin * 0.15;

  const dCx = portrait ? vpW * 0.73 : vpW * 0.82;
  const dCy = portrait ? vpH * 0.70 : vpH * 0.50;

  const OFFSET: Record<string, [number, number]> = {
    'diamond-top':    [0, -spacing],
    'diamond-bottom': [0,  spacing],
    'diamond-left':   [-spacing, 0],
    'diamond-right':  [ spacing, 0],
  };

  btnDefs.filter(d => d.slot !== 'center').forEach(d => {
    const [ox, oy] = OFFSET[d.slot] ?? [0, 0];
    const cx = dCx + ox;
    const cy = dCy + oy;
    const [wx, wy] = toWorld(cx, cy, vpW, vpH);
    zones.push({
      id: d.id, inputType: 'button', isBoolean: d.type === 'boolean',
      cx, cy, hitRadius: btnHit,
      wx, wy, wRadius: pxToWu(btnVisu, vpH),
      label: d.label, color: d.color ?? slotThemeColor(d.slot, theme),
      slot: d.slot,
    });
  });

  // ── Center buttons ────────────────────────────────────────────
  const cHit  = vmin * 0.09;
  const cVisu = vmin * 0.055;
  const centerBtns = btnDefs.filter(d => d.slot === 'center');
  centerBtns.forEach((d, i) => {
    const xOff = (i - (centerBtns.length - 1) / 2) * vmin * 0.15;
    const cx   = vpW * 0.50 + xOff;
    const cy   = portrait ? vpH * 0.88 : vpH * 0.87;
    const [wx, wy] = toWorld(cx, cy, vpW, vpH);
    zones.push({
      id: d.id, inputType: 'button', isBoolean: d.type === 'boolean',
      cx, cy, hitRadius: cHit,
      wx, wy, wRadius: pxToWu(cVisu, vpH),
      label: d.label, color: d.color ?? theme.btnCenter,
      slot: 'center',
    });
  });

  return zones;
}
