// ── Input values ────────────────────────────────────────────────
export interface Axis2DValue {
  type: 'axis2d';
  x: number; // -1..1
  y: number; // -1..1
}

export interface ButtonValue {
  type: 'button';
  pressed: boolean;
  duration: number; // ms held (0 on first press, total ms on release)
}

export interface BooleanValue {
  type: 'boolean';
  pressed: boolean; // no duration — purely on/off
}

export type InputValue = Axis2DValue | ButtonValue | BooleanValue;

// ── Input descriptors (controller layout schema) ────────────────
export interface Axis2DDescriptor {
  type: 'axis2d';
  id: string;
  slot: 'left' | 'right';
  color?: string; // overrides theme joystick color
}

export interface ButtonDescriptor {
  type: 'button';
  id: string;
  label: string;
  slot: 'diamond-top' | 'diamond-left' | 'diamond-right' | 'diamond-bottom' | 'center';
  color?: string;
}

export interface BooleanDescriptor {
  type: 'boolean';
  id: string;
  label?: string;
  slot: ButtonDescriptor['slot'];
  color?: string;
}

export type InputDescriptor = Axis2DDescriptor | ButtonDescriptor | BooleanDescriptor;

// ── Patch — one changed input ───────────────────────────────────
export interface InputPatch {
  controllerId: string;
  id: string;
  /**
   * Identifiant stable de la zone physique.
   * Égal à `id` pour les zones uniques.
   * Suffixé `__0`, `__1`… pour les zones SVG partageant le même id (ex: deux joysticks).
   * Permet au serveur de toujours distinguer quelle instance physique a été touchée.
   */
  zoneKey: string;
  value: InputValue;
}

// ── STOMP payload: array of patches from one controller frame ───
export interface ControllerFrame {
  t: number; // Client-side timestamp (ms)
  patches: InputPatch[];
}
