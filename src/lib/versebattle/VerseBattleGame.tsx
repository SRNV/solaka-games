import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, useTexture } from '@react-three/drei';
import { EffectComposer, Bloom, wrapEffect } from '@react-three/postprocessing';
import { Effect, EffectAttribute } from 'postprocessing';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { ControllerDisplay } from '../../hooks/useGameRoom.ts';
import type { ControllerFrame, InputValue } from '../../types/inputs.ts';
import { SpriteAnimService, SpriteAnimLayer, type SpriteAnimDef } from '../SpriteAnim.tsx';
import { HitAnimService, HitAnimLayer, type HitSequenceDef } from '../HitAnimService.tsx';
import { getGamesStompClient, isGamesStompConnected } from '../../gamesStompClient.ts';

type ControllerState = Record<string, InputValue>;

// ── Constants ─────────────────────────────────────────────────────────────────

const LANE_X       = [-24, -16, -8, 0, 8, 16, 24] as const;
const LANE_WIDTH   = 5.5;

const ZONE_MIN_Z   = 25;
const ZONE_MAX_Z   = 52;

const BRANCH_POOL        = 200;
const MIN_ACTIVE        = 40;
const SPAWN_Z           = -680;  // well past fog full (camera Z=88, fogFar=700 → full fog at Z≈-612)
const ELIM_BOT_Z        = 100;   // just past camera
const ENM_MIN_R         = 1.5;
const ENM_MAX_R         = 8.33;
const SPAWN_INTERVAL_MS = 200;   // ~5/s — trees are now 15× taller, need more spacing

const P_RADIUS      = 1.5;
const P_SPEED       = 48;
const JUMP_VEL      = 14;
const FRICTION_RATE = 8;
const INVINCIBLE_MS = 3000;

const DASH_SPEED       = 94.55;
const DASH_DIST        = 12.4;
const DASH_COOLDOWN_MS = 700;

const BEAM_RANGE   = 110;
const BEAM_TTL_MS  = 220;
const BEAM_PUSH    = 160;
const FIRE_HZ      = 8;
const CONE_HALF    = 0.06;

// Panel X slots: N positions centered on 0, pitch = W + W/10 (gap of W/10 between edges)
const PANEL_WIDTH   = 8 + LANE_WIDTH;
const PANEL_N_SLOTS = 4;
const PANEL_PITCH   = PANEL_WIDTH * 1.1; // center-to-center = W + W/10
const PANEL_SLOT_X: readonly number[] = Array.from(
  { length: PANEL_N_SLOTS },
  (_, i) => (i - (PANEL_N_SLOTS - 1) / 2) * PANEL_PITCH,
); // e.g. [-22.275, -7.425, 7.425, 22.275] for W=13.5

const LANE_BOUND_X = PANEL_SLOT_X[PANEL_N_SLOTS - 1] + PANEL_WIDTH / 2 + 1;
const PANEL_H       = 21.0;
const PANEL_D_MIN   = 5.0;
const PANEL_D_MAX   = PANEL_D_MIN * 4;
const PANEL_SPEED   = 10;
const PANEL_HZ      = 0.3;
const PANEL_POOL    = 24;
const EVAPORATE_MS  = 400;
const ZONE_ANIM_MS  = 300;

// Verse block (fast-moving verse representation)
const VBLOCK_POOL       = 8;
const VBLOCK_SEGS       = 16;          // Z subdivisions for shader terrain deformation
const VBLOCK_H          = PANEL_H;     // same height as zone panels
const VBLOCK_D          = 4.0;         // base depth unit (also shortest possible block)
const VBLOCK_D_MIN      = VBLOCK_D * 1.1;   // 4.4
const VBLOCK_D_MAX      = VBLOCK_D * 15;    // 60
const VBLOCK_SPEED      = 60;
const VBLOCK_VALID_LEAD = 30;          // units before ZONE_MIN_Z where block is validatable
const VBLOCK_BOTH_PROB  = 1 / 500;     // max probability of 'both' (short blocks), scales with length
const ZONE_PROB         = 0.25;        // fraction of spawns that are zones; rest are blocks

const TERRAIN_W     = 130;
const TERRAIN_SEG_W = 60;
const TERRAIN_SEG_L = 200;
const TERRAIN_LEN   = 700; // extends to fog limit
const TERRAIN_Z_OFF = -200; // shift toward horizon (camera is at Z=88)

// Box obstacle pool
const BOX_POOL  = 10;
const BOX_W     = 5;
const BOX_H     = 3.5;
const BOX_D     = 5;

const PANEL_CSS_COLORS = ['#da19cd','#3498db','#f39c12','#7261dd','#1abc9c','#e67e22'];
const PANEL_COLORS = PANEL_CSS_COLORS.map(c => new THREE.Color(c).multiplyScalar(5));

const PALETTE = [
  '#e74c3c', '#3498db', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#e91e63', '#00bcd4',
];

const CLEAR_MS        = 700;  // grow-down clearing animation duration
const ROUND_INTRO_S   = 7;    // intro popup duration (seconds)
const ROUND_PLAY_S    = 70;   // playing phase duration (seconds)

// Singletons mutated by VerseBattleGame on each new round
const _rollParams  = { ampScale: 1.0, freqScale: 1.0, gateProb: 0.01 };
const _pitchParams = { ampScale: 0.0, freqScale: 1.0 };
const _yawParams   = { ampScale: 0.0, freqScale: 1.0, gateProb: 0.01 };

export interface GameConfig {
  mode:        'rounds' | 'elimination';
  roundCount:  number;
  difficulty:  'easy' | 'medium' | 'hard' | 'chaos' | 'progressive';
  books:       string[] | 'all';
  batchStyle:  'per-round' | 'whole-game';
}

interface Difficulty {
  maxEnemies:      number;
  enemySizeScale:  number;
  maxBoxes:        number;
  maxPanels:       number;
  rollAmpScale:    number;
  rollFreqScale:   number;
  rollGateProb:    number;
  pitchAmpScale:   number;
  pitchFreqScale:  number;
  yawAmpScale:     number;
  yawFreqScale:    number;
  yawGateProb:     number;
}

function getDifficulty(round: number): Difficulty {
  const r     = round - 1;
  const rampR = Math.max(0, round - 2);
  const pitchPattern = [0, 0, 0.2, 0.07, 0.5, 0.15, 0.7, 0.3, 1.0, 0.4];
  const pitchAmp = pitchPattern[Math.min(r, pitchPattern.length - 1)];
  const rollGateProb = Math.min(0.65, 0.25 + r * (0.40 / 19));
  return {
    maxEnemies:     Math.min(BRANCH_POOL, MIN_ACTIVE + r * 2),
    enemySizeScale: 1 + r * 0.15,
    maxBoxes:       Math.min(BOX_POOL, r * 2),
    maxPanels:      Math.min(7, Math.max(4, 1 + round)),
    rollAmpScale:   round <= 2 ? 0.08 : Math.min(2.5, 0.3 + rampR * 0.35),
    rollFreqScale:  round <= 2 ? 0.5  : Math.min(2.0, 0.8 + rampR * 0.12),
    rollGateProb,
    pitchAmpScale:  pitchAmp,
    pitchFreqScale: Math.min(2.0, 0.7 + rampR * 0.13),
    yawAmpScale:    round <= 2 ? 0 : Math.min(2.0, 0.25 + rampR * 0.22),
    yawFreqScale:   round <= 2 ? 0.8 : Math.min(2.0, 0.8 + rampR * 0.10),
    yawGateProb:    Math.min(0.55, 0.18 + r * (0.37 / 19)),
  };
}

function getEffectiveRound(round: number, difficulty: GameConfig['difficulty']): number {
  switch (difficulty) {
    case 'easy':        return 1;
    case 'medium':      return 4;
    case 'hard':        return 8;
    case 'chaos':       return 20;
    case 'progressive': return round;
  }
}

type ClearableHandle = { startClear: () => void };

// ── Shared terrain functions ───────────────────────────────────────────────────
//
// Road yaw: slow L/R curves. 0 in player zone, grows toward horizon.
// Amplitude ramps from 0 to full over 60 s. JS must mirror TERRAIN_VERT exactly.
// Roll: rotation of terrain + all elements around the Z (road-forward) axis.
// Physics stays in local (unrolled) space; rendering applies roll transform.
// Ramps up over 40 s, strong amplitude (up to ~±80°).
// Roll noise: sum of incommensurable sines, normalized to [-1,1] × 2π = full rotation.
// Roll is zero near the player zone and grows progressively toward the horizon.
// zFactor goes from 0 at z>=ZONE_MIN_Z to 1 at z=-200 (TERRAIN_Z_OFF).
// Roll angle is a spatial wave that scrolls toward the player at ~100 u/s,
// so each twisted section keeps its orientation as it advances.
// u = z * kz - t * (kz * 100) gives apparent scroll speed of 100 u/s.

// Roll is fixed per terrain section: u = z*kz - t*(kz*100) is constant for a point
// moving at 100 u/s, so each section keeps its roll from horizon to end.
// Gate is also a scrolling spatial wave → some sections roll, others don't.
const ROLL_LIMIT = Math.PI / 4;
function rollAngle(t: number, z: number): number {
  const kz    = 0.008 * _rollParams.freqScale;
  const u     = z * kz - t * (kz * 100);
  // Gate: slower scrolling wave → wide roll windows
  const gateU    = u * 0.38;
  const gateV    = Math.sin(gateU) * 0.6 + Math.sin(gateU * 0.66 + 1.7) * 0.4;
  const threshold = 1.0 - 2.0 * _rollParams.gateProb;
  const gate     = Math.max(0, Math.min(1, (gateV - (threshold - 0.35)) / 0.35));
  if (gate === 0) return 0;
  const noise = (
    0.55 * Math.sin(u) +
    0.35 * Math.sin(u * 1.6 + 1.13) +
    0.22 * Math.sin(u * 2.5 + 2.71) +
    0.14 * Math.sin(u * 3.8 + 0.42)
  ) / 1.26;
  return Math.max(-ROLL_LIMIT, Math.min(ROLL_LIMIT, _rollParams.ampScale * gate * Math.PI * 0.45 * noise));
}

const MAX_PITCH = Math.PI / 3; // 60° hard limit

// Pitch oscillation — spatial wave scrolling at ~60 u/s so only sections of the track pitch.
// At pitchAmpScale=1 and full noise the camera reaches exactly ±60°.
function pitchAngle(t: number, z: number): number {
  const amp = Math.min(1, t / 40) * _pitchParams.ampScale;
  const kz  = 0.005 * _pitchParams.freqScale;
  const u   = z * kz - t * (kz * 60);
  const noise = (
    0.60 * Math.sin(u + 0.8) +
    0.30 * Math.sin(u * 1.73 + 2.1) +
    0.18 * Math.sin(u * 2.91 + 0.4)
  ) / 1.08;
  return Math.max(-MAX_PITCH, Math.min(MAX_PITCH, amp * MAX_PITCH * noise));
}

const YAW_MAX = 28;
function roadXOffset(t: number, z: number): number {
  const kz = 0.005 * _yawParams.freqScale;
  const u  = z * kz - t * (kz * 100);
  const gateU = u * 0.42;
  const gateV = Math.sin(gateU) * 0.6 + Math.sin(gateU * 0.68 + 1.9) * 0.4;
  const threshold = 1.0 - 2.0 * _yawParams.gateProb;
  const gate = Math.max(0, Math.min(1, (gateV - (threshold - 0.35)) / 0.35));
  if (gate === 0) return 0;
  const noise = (
    0.50 * Math.sin(u + 0.3) +
    0.35 * Math.sin(u * 1.65 + 1.2) +
    0.20 * Math.sin(u * 2.7  + 2.5)
  ) / 1.05;
  return _yawParams.ampScale * gate * YAW_MAX * noise;
}

function applyRoll(lx: number, ly: number, t: number, z: number): [number, number] {
  const phi = rollAngle(t, z);
  const c = Math.cos(phi), s = Math.sin(phi);
  return [lx * c - ly * s, lx * s + ly * c];
}

function applyRollYaw(lx: number, ly: number, t: number, z: number): [number, number] {
  const [rx, ry] = applyRoll(lx, ly, t, z);
  return [rx + roadXOffset(t, z), ry];
}

// Quaternion that aligns element's local Y with the rolled terrain normal at (localX, z).
const _tmpN  = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
function surfaceQuat(localX: number, z: number, t: number, out: THREE.Quaternion): THREE.Quaternion {
  const eps = 0.5;
  const dydx = (terrainY(localX + eps, z, t) - terrainY(localX - eps, z, t)) / (2 * eps);
  const dydz = (terrainY(localX, z + eps, t) - terrainY(localX, z - eps, t)) / (2 * eps);
  // Local terrain normal
  const phi = rollAngle(t, z);
  const c = Math.cos(phi), s = Math.sin(phi);
  const nx = -dydx, ny = 1;
  // Rotate normal by roll around Z
  _tmpN.set(nx * c - ny * s, nx * s + ny * c, -dydz).normalize();
  return out.setFromUnitVectors(_worldUp, _tmpN);
}


// Road goes straight (X never shifts). Terrain deforms only on Y.
// uTime increasing makes the hills scroll toward the player — driving illusion.

// Bumps scroll at 100 u/s. Clusters = squared-sine envelopes at low freq.
// Intensity ramps from 0 → 1 over 90 s of game time.
// Cylindrical volume: flat playing zone, parabolic drop-off at edges.
// Center stays flat for gameplay; edges drop away to reveal the volume of the cylinder.
const CYL_R = 300; // cylinder radius — terrain conforms to this circular cross-section

function terrainY(localX: number, z: number, t: number): number {
  const ramp = Math.min(1, t / 90);
  const c1 = Math.max(0, Math.sin(z * 0.031 - t * 3.1));
  const c2 = Math.max(0, Math.sin(z * 0.019 - t * 1.9 + 2.3));
  const c3 = Math.max(0, Math.sin(z * 0.051 - t * 5.1 + 0.7));
  const env = c1 * c1 * 0.7 + c2 * c2 * 0.9 + c3 * c3 * 0.4;
  const base = 0.4 * Math.sin(z * 0.05 - t * 5.0) + 0.2 * Math.sin(z * 0.031 + localX * 0.02 - t * 3.1);
  const bumps = base + ramp * env * (
    3.2  * Math.sin(z * 0.137  - t * 13.7) +
    2.1  * Math.sin(z * 0.0893 + localX * 0.04  - t *  8.93 + 1.57) +
    1.4  * Math.sin(z * 0.211  - localX * 0.061 - t * 21.1  + 0.83) +
    0.9  * Math.sin(z * 0.073  + localX * 0.029 - t *  7.3  + 3.14) +
    0.5  * Math.sin(z * 0.317  - localX * 0.08  - t * 31.7  + 2.0)
  );
  return bumps + Math.sqrt(Math.max(0, CYL_R * CYL_R - localX * localX)) - CYL_R;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type SpawnBeam = (from: THREE.Vector3, to: THREE.Vector3) => void;

type ZoneHandle = {
  tryValidate:  (playerId: string, playerX: number, playerZ: number) => void;
  getZoneColor: (playerX: number, playerZ: number) => THREE.Color | null;
  setCurrentVerse: (v: GameVerse | null) => void;
};

type EnemySlot = {
  active: boolean;
  localX: number;
  z: number;
  y: number;
  vx: number; vz: number; baseVz: number; radius: number; meshIdx: number;
  clearing: boolean; clearStart: number;
};

type EnemyHandle = {
  slots: EnemySlot[];
  pushSlot: (idx: number, fx: number, fz: number) => void;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPressed(val: InputValue | undefined): boolean {
  if (!val) return false;
  return (val.type === 'button' || val.type === 'boolean') && val.pressed;
}

function rnd(min: number, max: number) { return min + Math.random() * (max - min); }
function randLane() { return LANE_X[Math.floor(Math.random() * LANE_X.length)]; }

// ── Camera ────────────────────────────────────────────────────────────────────

// Camera high up, player zone at bottom of frame, looking toward horizon.
const CAM_Z  = 88;
const CAM_H  = 42;   // high so player zone appears at bottom of frame
const LOOK_Z = -65;
const LOOK_H = 6;

// Smoothed tilt angles tracked at module level (survive re-renders)
const _camTilt = { roll: 0, pitch: 0 };

// Frustum safety: keep ZONE_MAX_Z always in frame.
// Positive pitch (nose-up) pushes zone toward bottom edge — capped at remaining margin.
const _fwdAngle     = Math.atan2(CAM_H - LOOK_H, CAM_Z - LOOK_Z);      // ~13°
const _zoneAngle    = Math.atan2(CAM_H,           CAM_Z - ZONE_MAX_Z); // ~49°
const _halfFovRad   = (78 / 2) * Math.PI / 180;                         // 39°
const SAFE_PITCH_UP = _halfFovRad - (_zoneAngle - _fwdAngle);           // ~0.05 rad
const SAFE_PITCH_DN = Math.min(MAX_PITCH, _halfFovRad + (_zoneAngle - _fwdAngle)); // min(60°, ~75°) → 60°


function CameraRig() {
  const { camera } = useThree();
  const camPos    = useRef(new THREE.Vector3(0, CAM_H, CAM_Z));
  const lookPos   = useRef(new THREE.Vector3(0, LOOK_H, LOOK_Z));
  const tiltQuat  = useRef(new THREE.Quaternion());
  const rollQuat  = useRef(new THREE.Quaternion());

  useLayoutEffect(() => {
    camera.position.copy(camPos.current);
    camera.lookAt(lookPos.current);
  }, [camera]);

  useFrame((state, delta) => {
    const t   = state.clock.getElapsedTime();
    const lam = Math.min(1, delta * 2.8);
    // Tilt lag: camera follows terrain roll with moderate damping, pitch slower
    const tiltLam = Math.min(1, delta * 1.2);

    const tyCam  = terrainY(0, CAM_Z, t);
    const tyLook = terrainY(0, LOOK_Z, t);
    const xOffCam  = roadXOffset(t, CAM_Z);
    const xOffLook = roadXOffset(t, LOOK_Z);
    camPos.current.set(xOffCam,  tyCam  + CAM_H,  CAM_Z);
    lookPos.current.set(xOffLook, tyLook + LOOK_H, LOOK_Z);
    camera.position.lerp(camPos.current, lam);

    // Sample roll at the midpoint of the player zone (z ≈ 38)
    const targetRoll  = rollAngle(t, (ZONE_MIN_Z + ZONE_MAX_Z) / 2);
    const targetPitch = pitchAngle(t, (ZONE_MIN_Z + ZONE_MAX_Z) / 2);
    _camTilt.roll  += (targetRoll  - _camTilt.roll)  * tiltLam;
    _camTilt.pitch += (targetPitch - _camTilt.pitch) * tiltLam;
    _camTilt.pitch  = Math.max(-SAFE_PITCH_DN, Math.min(SAFE_PITCH_UP, _camTilt.pitch));

    // Base look-at quaternion
    const tmp = camera.clone() as THREE.Camera;
    tmp.lookAt(lookPos.current);

    // Apply roll around camera-local Z (forward axis), pitch around local X (right axis)
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(tmp.quaternion);
    const right   = new THREE.Vector3(1, 0,  0).applyQuaternion(tmp.quaternion);
    rollQuat.current.setFromAxisAngle(forward, -_camTilt.roll);
    tiltQuat.current.setFromAxisAngle(right,   _camTilt.pitch);
    tmp.quaternion.premultiply(tiltQuat.current).premultiply(rollQuat.current);

    camera.quaternion.slerp(tmp.quaternion, lam);
  });
  return null;
}

// ── Particles ─────────────────────────────────────────────────────────────────

const PARTICLE_COUNT = 100;
const PARTICLE_SPEED = 95; // matches terrain visual scroll speed

const PARTICLE_FRAG = /* glsl */`
uniform float uFogNear;
uniform float uFogFar;
varying float vFog;
varying vec2  vUv;
void main() {
  float d = length(vUv - 0.5);
  float alpha = smoothstep(0.5, 0.1, d);
  alpha *= 1.0 - vFog;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(1.0, 1.0, 1.0, alpha * 0.72);
}
`;
const PARTICLE_VERT = /* glsl */`
uniform float uFogNear;
uniform float uFogFar;
varying float vFog;
varying vec2  vUv;
void main() {
  vUv = uv;
  vec4 mvPos = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  float dist = length((modelMatrix * instanceMatrix * vec4(0.0,0.0,0.0,1.0)).xyz - cameraPosition);
  vFog = smoothstep(uFogNear, uFogFar, dist);
  gl_Position = projectionMatrix * mvPos;
}
`;

function ParticleField() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  // Evenly distribute initial Z across the full range so particles never cluster.
  const SPAN = CAM_Z - TERRAIN_Z_OFF;
  const data = useMemo(() => Array.from({length: PARTICLE_COUNT}, (_, i) => ({
    x:    rnd(-TERRAIN_W / 2, TERRAIN_W / 2),
    y:    rnd(0, 28),
    z:    TERRAIN_Z_OFF + (i / PARTICLE_COUNT) * SPAN + rnd(0, SPAN / PARTICLE_COUNT),
    size: rnd(0.08, 0.38),
  })), []); // eslint-disable-line react-hooks/exhaustive-deps

  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VERT,
    fragmentShader: PARTICLE_FRAG,
    uniforms: { uFogNear: { value: 180 }, uFogFar: { value: 700 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  }), []);

  useFrame((state, delta) => {
    const mesh = meshRef.current; if (!mesh) return;
    const cam  = state.camera;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = data[i];
      p.z += PARTICLE_SPEED * delta;
      if (p.z > CAM_Z + 10) {
        p.z = TERRAIN_Z_OFF + rnd(0, 30);
        p.x = rnd(-TERRAIN_W / 2, TERRAIN_W / 2);
        p.y = rnd(0, 28);
      }
      // Billboard: align plane toward camera
      _pos3.set(p.x, p.y, p.z);
      _squat.copy(cam.quaternion);
      _scale.setScalar(p.size);
      _mat4.compose(_pos3, _squat, _scale);
      mesh.setMatrixAt(i, _mat4);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, PARTICLE_COUNT]} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
      <primitive object={mat} attach="material" />
    </instancedMesh>
  );
}

// ── Canopy Billboard ──────────────────────────────────────────────────────────


const CANOPY_VERT = /* glsl */`
varying vec2  vUv;
varying vec3  vWorldPos;
void main() {
  vUv = uv;
  // Billboard: expand quad in camera space around instance center.
  vec4 worldCenter = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vWorldPos = worldCenter.xyz;
  vec4 mvCenter = viewMatrix * worldCenter;
  // position.xy = quad corner, position.z = half-size encoded as scale
  vec4 mvPos = mvCenter + vec4(position.xy, 0.0, 0.0);
  gl_Position = projectionMatrix * mvPos;
}`;

const CANOPY_FRAG = /* glsl */`
uniform vec3  uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec2  vUv;
varying vec3  vWorldPos;

float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float vnoise(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y);
}

void main() {
  vec2 uv = vUv * 2.0 - 1.0; // -1..1
  float r = length(uv);
  // Overall spherical canopy mask
  float sphere = smoothstep(1.0, 0.55, r);
  if (sphere < 0.01) discard;
  // Multi-octave noise for organic leaf texture
  float n =  vnoise(uv * 4.0 + 0.5) * 0.50
           + vnoise(uv * 9.0 + 1.3) * 0.30
           + vnoise(uv * 18.0 + 2.7) * 0.20;
  float foliage = sphere * n;
  if (foliage < 0.28) discard;
  // Dark-to-light green, darker at edges
  float lit = vnoise(uv * 6.0 + vec2(3.1, 1.7));
  vec3 col = mix(vec3(0.02, 0.09, 0.01), vec3(0.08, 0.32, 0.04), lit * sphere);
  float fog = smoothstep(uFogNear, uFogFar, distance(vWorldPos, cameraPosition));
  gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
}`;

// Fixed canopy billboards at the far end of the map — they never scroll closer.
// They rotate with the camera (billboard) and sway gently with the tree tilt.
const CANOPY_FAR_Z = TERRAIN_Z_OFF - TERRAIN_LEN / 2 + 30; // deep in fog, near tree base

function CanopyField() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  // Spread of billboard planes around the far-end tree top
  const data = useMemo(() => [
    { x:   0, yOff: 80, size: 130 },
    { x: -18, yOff: 55, size:  90 },
    { x:  16, yOff: 50, size:  85 },
    { x:   8, yOff:100, size: 110 },
    { x: -10, yOff: 70, size: 100 },
    { x:  22, yOff: 60, size:  75 },
    { x:  -6, yOff: 40, size:  70 },
  ], []);

  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: CANOPY_VERT, fragmentShader: CANOPY_FRAG,
    uniforms: { uFogColor: {value: new THREE.Color(0x02A9EA)}, uFogNear: {value:180}, uFogFar: {value:700} },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  }), []);

  const N = data.length;
  useFrame((state) => {
    const mesh = meshRef.current; if (!mesh) return;
    const t = state.clock.getElapsedTime();
    for (let i = 0; i < N; i++) {
      const p = data[i];
      // Anchor at a fixed world Z in the fog; follow lateral tree sway
      const az = CANOPY_FAR_Z;
      const ax = p.x + roadXOffset(t, az);
      const ay = terrainY(0, az, t) + p.yOff;
      const [wx, wy] = applyRollYaw(ax, ay, t, az);
      _pos3.set(wx, wy, az);
      _squat.copy(state.camera.quaternion);
      _scale.setScalar(p.size);
      _mat4.compose(_pos3, _squat, _scale);
      mesh.setMatrixAt(i, _mat4);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, N]} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
      <primitive object={mat} attach="material" />
    </instancedMesh>
  );
}

// ── Leaf Particles ────────────────────────────────────────────────────────────

// Leaf particles arranged in clusters that scroll together
const LEAF_CLUSTERS    = 7;
const LEAVES_PER_CLUSTER = 8;
const LEAF_PART_COUNT  = LEAF_CLUSTERS * LEAVES_PER_CLUSTER;

// Palette of 5 leaf/branch colors — a random gradient is generated at game start.
const LEAF_PALETTE_HEX = [0x00B9AE, 0xA7754D, 0x295135, 0x98CE00, 0x9FCC2E] as const;

// Generate a gradient of `n` colors by stepping through the palette in a random order.
function buildLeafGradient(n: number): THREE.Color[] {
  const order = [...LEAF_PALETTE_HEX].sort(() => Math.random() - 0.5);
  const segs  = order.length - 1;
  return Array.from({ length: n }, (_, i) => {
    const t   = (i / Math.max(1, n - 1)) * segs;
    const si  = Math.min(Math.floor(t), segs - 1);
    const c   = new THREE.Color(order[si]).lerp(new THREE.Color(order[si + 1]), t - si);
    return c;
  });
}

const LEAF_PART_VERT = /* glsl */`
uniform float uFogNear;
uniform float uFogFar;
varying float vFog;
varying vec2  vUv;
varying vec3  vInstCol;
void main() {
  vUv = uv;
  #ifdef USE_INSTANCING_COLOR
    vInstCol = instanceColor;
  #else
    vInstCol = vec3(0.10, 0.40, 0.06);
  #endif
  vec4 mvPos = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  float dist = length((modelMatrix * instanceMatrix * vec4(0.0,0.0,0.0,1.0)).xyz - cameraPosition);
  vFog = smoothstep(uFogNear, uFogFar, dist);
  gl_Position = projectionMatrix * mvPos;
}`;

const LEAF_PART_FRAG = /* glsl */`
uniform float uFogNear;
uniform float uFogFar;
varying float vFog;
varying vec2  vUv;
varying vec3  vInstCol;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float hw = sqrt(max(0.0, 1.0 - p.y * p.y));
  if (abs(p.x) > hw * 0.46) discard;
  float rib = 1.0 - abs(p.x) / (hw * 0.46 + 0.001);
  vec3 col = mix(vInstCol * 0.45, vInstCol, rib);
  float alpha = (1.0 - vFog) * 0.85;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col, alpha);
}`;

interface LeafData {
  dx: number; dy: number; dz: number;
  vx: number; vy: number; vz: number; // per-leaf drift relative to cluster
  size: number;
  spinAngle: number; spinRate: number; // rotation around leaf normal
  tiltX: number; tiltZ: number;
}
interface ClusterData { ax: number; az: number; ay: number; leaves: LeafData[]; }

function makeCluster(i: number, totalClusters: number): ClusterData {
  const SPAN = CAM_Z - TERRAIN_Z_OFF;
  return {
    ax: rnd(-TERRAIN_W / 3, TERRAIN_W / 3),
    az: TERRAIN_Z_OFF + (i / totalClusters) * SPAN + rnd(0, SPAN / totalClusters),
    ay: rnd(25, 60),
    leaves: Array.from({ length: LEAVES_PER_CLUSTER }, () => ({
      dx: rnd(-2.5, 2.5), dy: rnd(-2, 2), dz: rnd(-2.5, 2.5),
      vx: rnd(-4, 4), vy: rnd(-2.5, -0.4), vz: rnd(-3, 3), // individual drift
      size: rnd(0.8, 2.4),
      spinAngle: rnd(0, Math.PI * 2),
      spinRate:  rnd(0.4, 2.8) * (Math.random() < 0.5 ? 1 : -1),
      tiltX: rnd(-0.7, 0.7), tiltZ: rnd(-0.7, 0.7),
    })),
  };
}

function LeafParticleField() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const clusters = useRef(Array.from({ length: LEAF_CLUSTERS }, (_, i) => makeCluster(i, LEAF_CLUSTERS)));
  const partGradient = useMemo(() => buildLeafGradient(LEAF_PART_COUNT), []);

  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: LEAF_PART_VERT, fragmentShader: LEAF_PART_FRAG,
    uniforms: { uFogNear: {value:180}, uFogFar: {value:700} },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  }), []);

  const _leafQ = useMemo(() => new THREE.Quaternion(), []);
  const _tiltQ = useMemo(() => new THREE.Quaternion(), []);
  const _euler  = useMemo(() => new THREE.Euler(), []);

  useFrame((state, delta) => {
    const mesh = meshRef.current; if (!mesh) return;
    const cam  = state.camera;
    let idx = 0;
    for (let ci = 0; ci < LEAF_CLUSTERS; ci++) {
      const c = clusters.current[ci];
      c.az += PARTICLE_SPEED * delta;
      c.ay -= delta * 0.8;
      if (c.az > CAM_Z + 10 || c.ay < 4) {
        const nc = makeCluster(0, 1);
        nc.az = TERRAIN_Z_OFF + rnd(0, 40);
        clusters.current[ci] = nc;
        continue;
      }
      for (let li = 0; li < LEAVES_PER_CLUSTER; li++) {
        const l = c.leaves[li];
        // Per-leaf independent drift
        l.dx += l.vx * delta;
        l.dy += l.vy * delta;
        l.dz += l.vz * delta;
        l.spinAngle += l.spinRate * delta;
        const wx = c.ax + l.dx;
        const wy = c.ay + l.dy;
        const wz = c.az + l.dz;
        _pos3.set(wx, wy, wz);
        // Billboard then tilt then spin
        _leafQ.copy(cam.quaternion);
        _euler.set(l.tiltX, l.spinAngle, l.tiltZ);
        _tiltQ.setFromEuler(_euler);
        _leafQ.multiply(_tiltQ);
        _scale.setScalar(l.size);
        _mat4.compose(_pos3, _leafQ, _scale);
        mesh.setMatrixAt(idx, _mat4);
        mesh.setColorAt(idx, partGradient[idx]);
        idx++;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, LEAF_PART_COUNT]} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
      <primitive object={mat} attach="material" />
    </instancedMesh>
  );
}

// ── Dynamic Terrain ───────────────────────────────────────────────────────────

// GLSL must exactly mirror JS roadXOffset / terrainY above.
// Added: vLocalX varying for lane stripes in fragment shader.
const TERRAIN_VERT = /* glsl */`
attribute float aBaseX;
attribute float aBaseZ;
uniform float uTime;
uniform float uRollAmpScale;
uniform float uRollGateProb;
uniform float uRollFreqScale;
uniform float uYawAmpScale;
uniform float uYawFreqScale;
uniform float uYawGateProb;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying float vLocalX;

float tY(float lx, float z) {
  float ramp = min(1.0, uTime / 90.0);
  float c1 = max(0.0, sin(z * 0.031 - uTime * 3.1));
  float c2 = max(0.0, sin(z * 0.019 - uTime * 1.9 + 2.3));
  float c3 = max(0.0, sin(z * 0.051 - uTime * 5.1 + 0.7));
  float env = c1 * c1 * 0.7 + c2 * c2 * 0.9 + c3 * c3 * 0.4;
  float base = 0.4 * sin(z * 0.05 - uTime * 5.0) + 0.2 * sin(z * 0.031 + lx * 0.02 - uTime * 3.1);
  float bumps = base + ramp * env * (
    3.2  * sin(z * 0.137  - uTime * 13.7) +
    2.1  * sin(z * 0.0893 + lx * 0.04  - uTime *  8.93 + 1.57) +
    1.4  * sin(z * 0.211  - lx * 0.061 - uTime * 21.1  + 0.83) +
    0.9  * sin(z * 0.073  + lx * 0.029 - uTime *  7.3  + 3.14) +
    0.5  * sin(z * 0.317  - lx * 0.08  - uTime * 31.7  + 2.0)
  );
  return bumps + sqrt(max(0.0, ${CYL_R * CYL_R}.0 - lx*lx)) - ${CYL_R}.0;
}

float roadXOffsetFn(float z) {
  float kz = 0.005 * uYawFreqScale;
  float u  = z * kz - uTime * (kz * 100.0);
  float gateU = u * 0.42;
  float gateV = sin(gateU)*0.6 + sin(gateU*0.68+1.9)*0.4;
  float thr   = 1.0 - 2.0 * uYawGateProb;
  float gate  = clamp((gateV-(thr-0.35))/0.35, 0.0, 1.0);
  float noise = (0.50*sin(u+0.3) + 0.35*sin(u*1.65+1.2) + 0.20*sin(u*2.7+2.5)) / 1.05;
  return uYawAmpScale * gate * 28.0 * noise;
}

void main() {
  float lx = aBaseX;
  float ly = tY(lx, aBaseZ);

  // Roll: spatial wave scrolling at ~100 u/s — each section keeps its twist.
  float rollAmp = uRollAmpScale;
  float kz = 0.008 * uRollFreqScale;
  float u = aBaseZ * kz - uTime * (kz * 100.0);
  float gateU     = u * 0.38;
  float gateV     = sin(gateU) * 0.6 + sin(gateU * 0.66 + 1.7) * 0.4;
  float threshold = 1.0 - 2.0 * uRollGateProb;
  float rollGate  = clamp((gateV - (threshold - 0.35)) / 0.35, 0.0, 1.0);
  float noise = (
    0.55 * sin(u) +
    0.35 * sin(u * 1.6 + 1.13) +
    0.22 * sin(u * 2.5 + 2.71) +
    0.14 * sin(u * 3.8 + 0.42)
  ) / 1.26;
  float phi = clamp(rollGate * rollAmp * 3.14159265 * 0.45 * noise, -3.14159265 * 0.25, 3.14159265 * 0.25);
  float cosP = cos(phi), sinP = sin(phi);
  float wx = lx * cosP - ly * sinP + roadXOffsetFn(aBaseZ);
  float wy = lx * sinP + ly * cosP;

  // Analytic normal in local space, then rotate it with roll
  float eps = 0.9;
  float lyEX = tY(lx + eps, aBaseZ);
  float lyEZ = tY(lx, aBaseZ + eps);
  vec3 tXl = normalize(vec3(eps, lyEX - ly, 0.0));
  vec3 tZl = normalize(vec3(0.0, lyEZ - ly, eps));
  vec3 nLocal = cross(tZl, tXl);
  // Rotate normal with roll
  vNormal   = normalize(vec3(nLocal.x * cosP - nLocal.y * sinP,
                              nLocal.x * sinP + nLocal.y * cosP,
                              nLocal.z));
  vWorldPos = vec3(wx, wy, aBaseZ);
  vLocalX   = lx;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
}
`;

const TERRAIN_FRAG = /* glsl */`
uniform vec3 uLightDir;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uTime;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying float vLocalX;

void main() {
  vec3  N    = normalize(vNormal);
  float diff = max(dot(N, uLightDir), 0.0);
  vec3  col  = vec3(0.145, 0.086, 0.020) * (0.38 + 0.72 * diff);

  // Lane dashes — boundaries at multiples of 8, scrolling toward player
  float lx        = vLocalX;
  float lanePos   = mod(lx + 28.0, 8.0); // distance to nearest boundary
  float laneDist  = min(lanePos, 8.0 - lanePos);
  float laneStripe = 1.0 - smoothstep(0.1, 0.35, laneDist);
  float dashPhase = mod(vWorldPos.z * 0.25 - uTime * 25.0, 1.0);
  float dash      = step(dashPhase, 0.55);
  col = mix(col, vec3(0.773, 0.482, 0.341), laneStripe * dash * 0.65);

  // Zone boundary stripe baked into terrain at ZONE_MIN_Z
  float zDist  = abs(vWorldPos.z - ${ZONE_MIN_Z}.0);
  float stripe = 1.0 - smoothstep(0.0, 0.6, zDist);
  col = mix(col, vec3(1.0, 0.87, 0.0), stripe);

  float dist = distance(vWorldPos, cameraPosition);
  float fog  = smoothstep(uFogNear, uFogFar, dist);
  gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
}
`;

// ── Cylinder Volume ───────────────────────────────────────────────────────────
// A cylinder of radius CYL_R oriented along Z sits beneath the flat terrain.
// Its top surface (θ=0, y=0) aligns with the terrain center — the terrain itself
// is shaped to this same circular cross-section via terrainY. The visible result:
// a flat road with the cylinder sides dropping away on both edges.

const CYLINDER_VERT = /* glsl */`
attribute float aBaseX;
attribute float aBaseZ;
uniform float uTime;
uniform float uRollAmpScale;
uniform float uRollGateProb;
uniform float uRollFreqScale;
uniform float uYawAmpScale;
uniform float uYawFreqScale;
uniform float uYawGateProb;
varying vec3  vWorldPos;
varying float vLocalX;

float roadXOffsetFn(float z) {
  float kz = 0.005 * uYawFreqScale;
  float u  = z * kz - uTime * (kz * 100.0);
  float gateU = u * 0.42;
  float gateV = sin(gateU)*0.6 + sin(gateU*0.68+1.9)*0.4;
  float thr   = 1.0 - 2.0 * uYawGateProb;
  float gate  = clamp((gateV-(thr-0.35))/0.35, 0.0, 1.0);
  float noise = (0.50*sin(u+0.3) + 0.35*sin(u*1.65+1.2) + 0.20*sin(u*2.7+2.5)) / 1.05;
  return uYawAmpScale * gate * 28.0 * noise;
}

float bumpsOnly(float lx, float z) {
  float ramp = min(1.0, uTime / 90.0);
  float c1 = max(0.0, sin(z * 0.031 - uTime * 3.1));
  float c2 = max(0.0, sin(z * 0.019 - uTime * 1.9 + 2.3));
  float c3 = max(0.0, sin(z * 0.051 - uTime * 5.1 + 0.7));
  float env = c1*c1*0.7 + c2*c2*0.9 + c3*c3*0.4;
  float base = 0.4*sin(z*0.05-uTime*5.0) + 0.2*sin(z*0.031+lx*0.02-uTime*3.1);
  return base + ramp*env*(
    3.2 *sin(z*0.137  - uTime*13.7) +
    2.1 *sin(z*0.0893 + lx*0.04  - uTime*8.93  + 1.57) +
    1.4 *sin(z*0.211  - lx*0.061 - uTime*21.1  + 0.83) +
    0.9 *sin(z*0.073  + lx*0.029 - uTime*7.3   + 3.14) +
    0.5 *sin(z*0.317  - lx*0.08  - uTime*31.7  + 2.0)
  );
}

void main() {
  float lx = aBaseX;
  float ly = position.y + bumpsOnly(lx, aBaseZ);
  vLocalX   = lx;
  float rollAmp = uRollAmpScale;
  float kz = 0.008 * uRollFreqScale;
  float u = aBaseZ * kz - uTime * (kz * 100.0);
  float gateU     = u * 0.38;
  float gateV     = sin(gateU) * 0.6 + sin(gateU * 0.66 + 1.7) * 0.4;
  float threshold = 1.0 - 2.0 * uRollGateProb;
  float rollGate  = clamp((gateV - (threshold - 0.35)) / 0.35, 0.0, 1.0);
  float noise = (
    0.55 * sin(u) +
    0.35 * sin(u * 1.6 + 1.13) +
    0.22 * sin(u * 2.5 + 2.71) +
    0.14 * sin(u * 3.8 + 0.42)
  ) / 1.26;
  float phi  = clamp(rollGate * rollAmp * 3.14159265 * 0.45 * noise, -0.7854, 0.7854);
  float cosP = cos(phi), sinP = sin(phi);
  float wx   = lx * cosP - ly * sinP + roadXOffsetFn(aBaseZ);
  float wy   = lx * sinP + ly * cosP;
  vWorldPos  = vec3(wx, wy, aBaseZ);
  gl_Position = projectionMatrix * viewMatrix * vec4(wx, wy, aBaseZ, 1.0);
}
`;

const CYLINDER_FRAG = /* glsl */`
uniform vec3  uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec3  vWorldPos;
varying float vLocalX;
void main() {
  // Discard the top portion covered by terrain — eliminates z-fighting entirely.
  float alpha = smoothstep(${TERRAIN_W / 2 - 4}.0, ${TERRAIN_W / 2 + 2}.0, abs(vLocalX));
  if (alpha < 0.01) discard;
  vec3 col = vec3(0.145, 0.086, 0.020);
  float fog = smoothstep(uFogNear, uFogFar, distance(vWorldPos, cameraPosition));
  gl_FragColor = vec4(mix(col, uFogColor, fog), alpha);
}
`;

// ── Cylinder-only outline via mask render target + Sobel ──────────────────────
// CylinderVolume renders the cylinder silhouette into _cylMaskTarget each frame.
// EdgeOutlineEffect reads that mask and applies Sobel edge detection — so the
// outline appears only on the cylinder, not on terrain, players, or enemies.

// Shared mask target — written by CylinderVolume, read by EdgeOutlineEffect.
let _cylMaskTarget: THREE.WebGLRenderTarget | null = null;

const OUTLINE_THICK_NEAR = 3.0;  // px at camera
const OUTLINE_THICK_FAR  = 0.1;  // px at horizon

const CYLINDER_MASK_FRAG = /* glsl */`
varying float vLocalX;
void main() {
  float a = smoothstep(${TERRAIN_W / 2 + 3}.0, ${TERRAIN_W / 2 + 13}.0, abs(vLocalX));
  if (a < 0.01) discard;
  gl_FragColor = vec4(a, 0.0, 0.0, 1.0);
}
`;

const EDGE_OUTLINE_FRAG = /* glsl */`
  uniform sampler2D uCylMask;
  uniform float uThickness;
  uniform vec3  uEdgeColor;
  uniform vec3  uFogColor;
  uniform float uThreshold;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    if (inputColor.r > 0.04 || inputColor.b < 0.65) {
      outputColor = inputColor;
      return;
    }

    float thickScale = mix(${OUTLINE_THICK_NEAR.toFixed(2)}, ${OUTLINE_THICK_FAR.toFixed(2)}, uv.y);
    vec2 d = (uThickness * thickScale) / resolution;

    float m00 = texture2D(uCylMask, uv + vec2(-d.x, -d.y)).r;
    float m10 = texture2D(uCylMask, uv + vec2( 0.0, -d.y)).r;
    float m20 = texture2D(uCylMask, uv + vec2( d.x, -d.y)).r;
    float m01 = texture2D(uCylMask, uv + vec2(-d.x,  0.0)).r;
    float m21 = texture2D(uCylMask, uv + vec2( d.x,  0.0)).r;
    float m02 = texture2D(uCylMask, uv + vec2(-d.x,  d.y)).r;
    float m12 = texture2D(uCylMask, uv + vec2( 0.0,  d.y)).r;
    float m22 = texture2D(uCylMask, uv + vec2( d.x,  d.y)).r;

    float gx = -m00 - 2.0*m01 - m02 + m20 + 2.0*m21 + m22;
    float gy = -m00 - 2.0*m10 - m20 + m02 + 2.0*m12 + m22;
    float edge = sqrt(gx*gx + gy*gy);

    // Black from 0–30% of screen height, linear fade to fog color over the next 20%.
    vec3 lineColor = mix(uEdgeColor, uFogColor, clamp((uv.y - 0.5) / 0.2, 0.0, 1.0));
    float strength = smoothstep(uThreshold, uThreshold * 3.0, edge);
    outputColor = vec4(mix(inputColor.rgb, lineColor, strength), inputColor.a);
  }
`;

class EdgeOutlineEffectImpl extends Effect {
  constructor({ thickness = 1.0, color = new THREE.Color(0, 0, 0), threshold = 0.15 }: {
    thickness?: number; color?: THREE.Color; threshold?: number;
  } = {}) {
    super('EdgeOutline', EDGE_OUTLINE_FRAG, {
      uniforms: new Map<string, THREE.Uniform<unknown>>([
        ['uCylMask',   new THREE.Uniform(null as THREE.Texture | null)],
        ['uThickness', new THREE.Uniform(thickness)],
        ['uEdgeColor',  new THREE.Uniform(color)],
        ['uFogColor',   new THREE.Uniform(new THREE.Color(0x02A9EA))],
        ['uThreshold',  new THREE.Uniform(threshold)],
      ]),
    });
  }

  // Called each frame by postprocessing — lazily bind mask texture once it exists.
  override update(): void {
    if (_cylMaskTarget && !this.uniforms.get('uCylMask')!.value) {
      this.uniforms.get('uCylMask')!.value = _cylMaskTarget.texture;
    }
  }
}
const EdgeOutlineEffect = wrapEffect(EdgeOutlineEffectImpl);

const CYL_THETA_SEGS = 64;
const CYL_Z_SEGS     = 200;
const CYL_Z_START    = TERRAIN_Z_OFF - TERRAIN_LEN / 2; // same as terrain far edge
const CYL_Z_END      = TERRAIN_Z_OFF + TERRAIN_LEN / 2; // same as terrain near edge

function CylinderVolume() {
  const { size } = useThree();
  const geo = useMemo(() => {
    const nT = CYL_THETA_SEGS, nZ = CYL_Z_SEGS;
    const verts: number[] = [], bx: number[] = [], bz: number[] = [], idx: number[] = [];
    for (let iz = 0; iz <= nZ; iz++) {
      const z = CYL_Z_START + (iz / nZ) * (CYL_Z_END - CYL_Z_START);
      for (let it = 0; it <= nT; it++) {
        const theta = (it / nT) * Math.PI * 2;
        verts.push(CYL_R * Math.sin(theta), CYL_R * Math.cos(theta) - CYL_R, z);
        bx.push(CYL_R * Math.sin(theta));
        bz.push(z);
      }
    }
    for (let iz = 0; iz < nZ; iz++) {
      for (let it = 0; it < nT; it++) {
        const a = iz * (nT + 1) + it, b = a + nT + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('aBaseX',   new THREE.Float32BufferAttribute(bx, 1));
    g.setAttribute('aBaseZ',   new THREE.Float32BufferAttribute(bz, 1));
    g.setIndex(idx);
    return g;
  }, []);

  const mkUniforms = () => ({
    uTime:          { value: 0 },
    uRollAmpScale:  { value: 1.0 },
    uRollGateProb:  { value: 0.01 },
    uRollFreqScale: { value: 1.0 },
    uYawAmpScale:   { value: 0.0 },
    uYawFreqScale:  { value: 1.0 },
    uYawGateProb:   { value: 0.01 },
  });

  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader:   CYLINDER_VERT,
    fragmentShader: CYLINDER_FRAG,
    transparent:  true,
    depthWrite:   true,
    polygonOffset: true, polygonOffsetFactor: 1.0, polygonOffsetUnits: 1.0,
    uniforms: {
      ...mkUniforms(),
      uFogColor: { value: new THREE.Color(0x02A9EA) },
      uFogNear:  { value: 180 },
      uFogFar:   { value: 700 },
    },
    side: THREE.DoubleSide,
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const maskMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader:   CYLINDER_VERT,
    fragmentShader: CYLINDER_MASK_FRAG,
    transparent: true,
    depthTest:   false,
    depthWrite:  false,
    side: THREE.FrontSide,
    uniforms: mkUniforms(),
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const maskScene = useMemo(() => {
    const s = new THREE.Scene();
    const cylMesh = new THREE.Mesh(geo, maskMat);
    cylMesh.frustumCulled = false;
    s.add(cylMesh);
    return s;
  }, [geo, maskMat]);

  // Create/resize the shared mask render target.
  useLayoutEffect(() => {
    _cylMaskTarget = new THREE.WebGLRenderTarget(size.width, size.height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format:    THREE.RGBAFormat,
    });
    return () => { _cylMaskTarget?.dispose(); _cylMaskTarget = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(({ clock, gl, camera, size: s }) => {
    const t = clock.getElapsedTime();

    const syncUniforms = (u: Record<string, { value: unknown }>) => {
      u.uTime.value          = t;
      u.uRollAmpScale.value  = _rollParams.ampScale;
      u.uRollGateProb.value  = _rollParams.gateProb;
      u.uRollFreqScale.value = _rollParams.freqScale;
      u.uYawAmpScale.value   = _yawParams.ampScale;
      u.uYawFreqScale.value  = _yawParams.freqScale;
      u.uYawGateProb.value   = _yawParams.gateProb;
    };
    syncUniforms(mat.uniforms);
    syncUniforms(maskMat.uniforms);

    if (_cylMaskTarget) {
      if (_cylMaskTarget.width !== s.width || _cylMaskTarget.height !== s.height)
        _cylMaskTarget.setSize(s.width, s.height);

      const prevRT = gl.getRenderTarget();
      const prevCC = new THREE.Color(); gl.getClearColor(prevCC);
      const prevCA = gl.getClearAlpha();
      gl.setRenderTarget(_cylMaskTarget);
      gl.setClearColor(0x000000, 0);
      gl.clear();
      gl.render(maskScene, camera);
      // branches excluded from outline mask (no _branchMaskScene render)
      gl.setClearColor(prevCC, prevCA);
      gl.setRenderTarget(prevRT);
    }
  });

  return <mesh geometry={geo} receiveShadow={false} material={mat} frustumCulled={false} />;
}

function DynamicTerrain() {
  const geo = useMemo(() => {
    const g = new THREE.PlaneGeometry(TERRAIN_W, TERRAIN_LEN, TERRAIN_SEG_W, TERRAIN_SEG_L);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const bx  = new Float32Array(pos.count);
    const bz  = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) { bx[i] = pos.getX(i); bz[i] = pos.getZ(i) + TERRAIN_Z_OFF; }
    g.setAttribute('aBaseX', new THREE.BufferAttribute(bx, 1));
    g.setAttribute('aBaseZ', new THREE.BufferAttribute(bz, 1));
    return g;
  }, []);

  const FOG_COLOR = useMemo(() => new THREE.Color(0x02A9EA), []);
  const LIGHT_DIR = useMemo(() => new THREE.Vector3(20, 60, 40).normalize(), []);

  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader:   TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
    uniforms: {
      uTime:          { value: 0 },
      uRollAmpScale:  { value: 1 },
      uRollFreqScale: { value: 1 },
      uRollGateProb:  { value: 0.01 },
      uYawAmpScale:   { value: 0 },
      uYawFreqScale:  { value: 1 },
      uYawGateProb:   { value: 0.01 },
      uLightDir:      { value: LIGHT_DIR },
      uFogColor:      { value: FOG_COLOR },
      uFogNear:       { value: 180 },
      uFogFar:        { value: 700 },
    },
  }), [FOG_COLOR, LIGHT_DIR]);

  useFrame(({ clock }) => {
    mat.uniforms.uTime.value          = clock.getElapsedTime();
    mat.uniforms.uRollAmpScale.value  = _rollParams.ampScale;
    mat.uniforms.uRollFreqScale.value = _rollParams.freqScale;
    mat.uniforms.uRollGateProb.value  = _rollParams.gateProb;
    mat.uniforms.uYawAmpScale.value   = _yawParams.ampScale;
    mat.uniforms.uYawFreqScale.value  = _yawParams.freqScale;
    mat.uniforms.uYawGateProb.value   = _yawParams.gateProb;
  });

  // frustumCulled=false: bounding box is computed pre-shader (flat plane),
  // which is wrong after vertex displacement + Z offset — would cull incorrectly.
  return <mesh geometry={geo} material={mat} frustumCulled={false} />;
}

// ── MapBranch shaders & helpers ───────────────────────────────────────────────

const BRANCH_HEIGHT_MULT   = 30;
const LEAVES_PER_BRANCH    = 200;   // per branch — individual instances, clustered
const BRANCH_LEAF_CLUSTERS = 120;    // cluster centers distributed along the spine
const BRANCH_LEAVES_PER_CL = Math.ceil(LEAVES_PER_BRANCH / BRANCH_LEAF_CLUSTERS);
const SUB_PER_BRANCH       = 20;

// Shared GLSL: Rodrigues rotation + piecewise-linear spine with 2 bends.
// aBend  = (bendAngle1, bendAngle2, 0, totalHeight)
// aBendAxis = (axisAngle1, axisAngle2, 0, baseRadius)
// Bend angles are always >= 0 (never fold back toward base).
const GLSL_SPINE = /* glsl */`
attribute vec4 aBend;
attribute vec4 aBendAxis;

vec3 rotV(vec3 v, vec3 ax, float a) {
  float c=cos(a), s=sin(a), k=1.0-c;
  return v*c + cross(ax,v)*s + ax*dot(ax,v)*k;
}
vec3 spineDir(float h) {
  vec3 d = vec3(0.0,1.0,0.0);
  if (h > 0.333) d = rotV(d, normalize(vec3(cos(aBendAxis.x),0.0,sin(aBendAxis.x))), aBend.x);
  if (h > 0.667) d = rotV(d, normalize(vec3(cos(aBendAxis.y),0.0,sin(aBendAxis.y))), aBend.y);
  return normalize(d);
}
vec3 spinePos(float h) {
  float S = 0.333;
  vec3 d0 = vec3(0.0,1.0,0.0);
  vec3 d1 = rotV(d0, normalize(vec3(cos(aBendAxis.x),0.0,sin(aBendAxis.x))), aBend.x);
  vec3 d2 = rotV(d1, normalize(vec3(cos(aBendAxis.y),0.0,sin(aBendAxis.y))), aBend.y);
  vec3 p = d0 * min(h, S);
  if (h > S)       p += d1 * min(h-S, S);
  if (h > 2.0*S)   p += d2 * (h - 2.0*S);
  return p;
}
`;

const BRANCH_VERT = /* glsl */`
${GLSL_SPINE}
varying vec3 vWorldPos;
varying float vH;
void main() {
  // CylinderGeometry base at y=0, tip at y=1 (after translate(0, 0.5, 0))
  float h = position.y;
  vH = h;
  vec3 tang  = spineDir(h);
  vec3 spine = spinePos(h) * aBend.w;
  vec3 upH   = abs(tang.y) < 0.9 ? vec3(0,1,0) : vec3(1,0,0);
  vec3 right = normalize(cross(upH, tang));
  vec3 fwd   = cross(tang, right);
  vec3 radial = (right * position.x + fwd * position.z) * aBendAxis.w;
  vec4 world  = modelMatrix * instanceMatrix * vec4(spine + radial, 1.0);
  vWorldPos   = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const BRANCH_FRAG = /* glsl */`
uniform vec3  uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec3  vWorldPos;
varying float vH;
void main() {
  // Slightly lighter toward tip for depth reading
  vec3 col = mix(vec3(0.10,0.06,0.01), vec3(0.19,0.11,0.03), vH);
  float fog = smoothstep(uFogNear, uFogFar, distance(vWorldPos, cameraPosition));
  gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
}`;

// Each leaf is an individual instance — Perlin noise deforms the quad in local space.
const LEAF_VERT = /* glsl */`
varying vec2  vLUv;
varying vec3  vInstCol;

float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float vnoise(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h2(i),h2(i+vec2(1,0)),f.x),mix(h2(i+vec2(0,1)),h2(i+vec2(1,1)),f.x),f.y);
}

void main() {
  #ifdef USE_INSTANCING_COLOR
    vInstCol = instanceColor;
  #else
    vInstCol = vec3(0.08, 0.35, 0.05);
  #endif
  vLUv = uv;

  // Per-instance seed from translation column of instanceMatrix
  vec2 seed = instanceMatrix[3].xz * 0.07;

  // Multi-octave noise on UV — displaces along local Z (leaf normal)
  vec2 ns = uv * 2.8 + seed;
  float n  = vnoise(ns)       * 0.55
           + vnoise(ns * 2.3) * 0.30
           + vnoise(ns * 5.1) * 0.15;
  n = (n - 0.5) * 0.7; // center and scale displacement

  // Also slightly warp X so the leaf curls
  float nx = (vnoise(uv * 3.5 + seed + 17.3) - 0.5) * 0.25;

  vec3 pos = position + vec3(nx, 0.0, n);

  vec4 world  = modelMatrix * instanceMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const LEAF_FRAG = /* glsl */`
varying vec2  vLUv;
varying vec3  vInstCol;
void main() {
  // Leaf silhouette mask (ellipse shape trimmed from the quad)
  vec2 p  = vLUv * 2.0 - 1.0;
  float hw = sqrt(max(0.0, 1.0 - p.y * p.y));
  if (abs(p.x) > hw * 0.5) discard;
  // Slight rib darkening toward center
  float rib = 1.0 - abs(p.x) / (hw * 0.5 + 0.001);
  gl_FragColor = vec4(mix(vInstCol * 0.5, vInstCol, rib), 1.0);
}`;


function buildLeafQuadGeo(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5,0,0, 0.5,0,0, -0.5,1,0, 0.5,1,0], 3));
  g.setAttribute('uv',       new THREE.Float32BufferAttribute([0,0, 1,0, 0,1, 1,1], 2));
  g.setIndex([0,2,1, 1,2,3]);
  return g;
}

// JS Rodrigues + spine helpers (mirror of GLSL) for sub-branch attachment.
function jsRod(v: [number,number,number], ax: [number,number,number], a: number): [number,number,number] {
  const [vx,vy,vz] = v, [ex,ey,ez] = ax, c=Math.cos(a), s=Math.sin(a), k=1-c, d=ex*vx+ey*vy+ez*vz;
  return [vx*c+(ey*vz-ez*vy)*s+ex*d*k, vy*c+(ez*vx-ex*vz)*s+ey*d*k, vz*c+(ex*vy-ey*vx)*s+ez*d*k];
}
function jsSpinePos(h: number, b1: number, b2: number, a1: number, a2: number): [number,number,number] {
  const S=1/3; let d:[number,number,number]=[0,1,0], p:[number,number,number]=[0,0,0];
  const addV = (dd:[number,number,number], t:number) => { p[0]+=dd[0]*t; p[1]+=dd[1]*t; p[2]+=dd[2]*t; };
  addV(d, Math.min(h, S));
  if (h>S)   { d = jsRod(d, [Math.cos(a1),0,Math.sin(a1)], b1); addV(d, Math.min(h-S, S)); }
  if (h>2*S) { d = jsRod(d, [Math.cos(a2),0,Math.sin(a2)], b2); addV(d, h-2*S); }
  return p;
}
function jsSpineDir(h: number, b1: number, b2: number, a1: number, a2: number): [number,number,number] {
  let d:[number,number,number]=[0,1,0];
  if (h>1/3) d = jsRod(d, [Math.cos(a1),0,Math.sin(a1)], b1);
  if (h>2/3) d = jsRod(d, [Math.cos(a2),0,Math.sin(a2)], b2);
  return d;
}

// ── MapBranchManager ──────────────────────────────────────────────────────────

const _mat4  = new THREE.Matrix4();
const _mat4f = new THREE.Matrix4();
const _scale = new THREE.Vector3();
const _pos3  = new THREE.Vector3();
const _squat = new THREE.Quaternion();
const _tmpV3 = new THREE.Vector3();
const _worldUp2 = new THREE.Vector3(0, 1, 0);
const _subQuat  = new THREE.Quaternion();
// Leaf matrix scratch — reused every frame, no allocation
const _lTang    = new THREE.Vector3();
const _lRight   = new THREE.Vector3();
const _lFwd     = new THREE.Vector3();
const _lOut     = new THREE.Vector3();
const _lUp      = new THREE.Vector3();
const _lR       = new THREE.Vector3();
const _lCenter  = new THREE.Vector3();
const _branchM  = new THREE.Matrix4();
const _leafM    = new THREE.Matrix4();

type BranchSlot = EnemySlot & {
  b1: number; b2: number; a1: number; a2: number;
  subLocalOffs: THREE.Vector3[];
  subLocalDirs: THREE.Vector3[];
  subHeight: number[];
  subRadius: number[];
  spawnWX: number; spawnWY: number;
  spawnQuat: THREE.Quaternion;
  foliageCount: number;                      // 0 = no spheres (4/20 chance)
  foliageLocalOffs: THREE.Vector3[];         // per-sphere local offsets
  foliageSizes: number[];                    // per-sphere radii
  leafData: Float32Array;  // LEAVES_PER_BRANCH*4 — (heightFrac, radialAngle, size, tilt) per leaf
};
const FOL_MAX = 4; // max foliage spheres per branch

// ── Foliage Blob — post-process effect ───────────────────────────────────────
// Written by MapBranchManager each frame; read by FoliageBlobEffectImpl.update()
const MAX_FOL_TIPS = 48;
const _folTips = {
  pos:        new Float32Array(MAX_FOL_TIPS * 3),  // world-space for noise seeding
  ndc:        new Float32Array(MAX_FOL_TIPS * 3),  // projected NDC xy + z after .project()
  screenR:    new Float32Array(MAX_FOL_TIPS),       // blob radius in NDC units
  camDist:    new Float32Array(MAX_FOL_TIPS),       // camera distance for fog
  color:      new Float32Array(MAX_FOL_TIPS * 3),
  depthRange: [0, 1] as [number, number],            // [minDist, maxDist] of visible tips this frame
  count:      0,
  // scratch buffers for depth-sort (reused every frame, no allocation)
  _sortIdx:   new Uint8Array(MAX_FOL_TIPS),
  _tmpPos:    new Float32Array(MAX_FOL_TIPS * 3),
  _tmpNdc:    new Float32Array(MAX_FOL_TIPS * 3),
  _tmpScrR:   new Float32Array(MAX_FOL_TIPS),
  _tmpDist:   new Float32Array(MAX_FOL_TIPS),
  _tmpCol:    new Float32Array(MAX_FOL_TIPS * 3),
};

const FOL_BLOB_FRAG = /* glsl */`
uniform int   uTipCount;
uniform vec3  uTipPos[${MAX_FOL_TIPS}];
uniform vec3  uTipNDC[${MAX_FOL_TIPS}];
uniform float uTipScreenR[${MAX_FOL_TIPS}];
uniform float uTipCamDist[${MAX_FOL_TIPS}];
uniform vec3  uTipColor[${MAX_FOL_TIPS}];
uniform vec2  uDepthRange;
uniform float uAspect;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3  uFogColor;

float h21(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float vn3(vec3 p){
  vec3 i=floor(p);vec3 f=fract(p);f=f*f*(3.0-2.0*f);
  float a=h21(i.xy),b=h21(i.xy+vec2(1,0)),c=h21(i.xy+vec2(0,1)),d=h21(i.xy+vec2(1,1));
  float e=h21(i.xy+i.z*7.3),f2=h21(i.xy+vec2(1,0)+i.z*7.3);
  float g=h21(i.xy+vec2(0,1)+i.z*7.3),h2=h21(i.xy+vec2(1,1)+i.z*7.3);
  return mix(mix(mix(a,b,f.x),mix(c,d,f.x),f.y),mix(mix(e,f2,f.x),mix(g,h2,f.x),f.y),f.z);
}
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor){
  outputColor = inputColor;
  vec2 ndc = uv * 2.0 - 1.0;
  for(int i = 0; i < ${MAX_FOL_TIPS}; i++){
    if(i >= uTipCount) break;
    float blobZ = uTipNDC[i].z;
    if(blobZ > 1.0) continue;
    // Depth test: only render on background/sky pixels (depth ≈ 1.0).
    // This guarantees all scene geometry (branches, terrain) always occludes foliage.
    if(depth < 0.9995) continue;
    float sr = max(uTipScreenR[i], 0.001);
    vec2  diff = (ndc - uTipNDC[i].xy) * vec2(uAspect, 1.0);
    float d = length(diff) / sr;
    if(d > 2.5) continue;
    // Stable seed: world XY only (Z scrolls → flicker)
    vec3 seed = vec3(uTipPos[i].xy * 1.4, 0.57);
    // Use raw diff offset (not normalised dir) → each blob has asymmetric, unique shape
    // Pixels sample different noise points per direction → NOT rotationally symmetric
    vec3 pSeed = vec3(seed.xy * 0.5 + diff * 2.8, seed.z);
    float n = vn3(pSeed*1.6)*0.55 + vn3(pSeed*4.0)*0.28 + vn3(pSeed*9.5)*0.17;
    // Threshold rises with distance → dense core, sparse ragged fringe
    float threshold = 0.15 + d * 0.58;
    float coverage = step(threshold, n);
    if(coverage < 0.5) continue;
    float fog = smoothstep(uFogNear, uFogFar, uTipCamDist[i]);
    if(fog >= 0.99) continue;
    // Depth-relative brightness: close tips are full brightness, far tips are dimmer
    float depthSpan = max(uDepthRange.y - uDepthRange.x, 1.0);
    float depthT    = clamp((uTipCamDist[i] - uDepthRange.x) / depthSpan, 0.0, 1.0);
    float depthBrightness = mix(1.0, 0.42, depthT);
    vec3 blobCol = mix(uTipColor[i]*(0.45 + n*0.55)*depthBrightness, uFogColor, fog);
    outputColor.rgb = mix(outputColor.rgb, blobCol, (1.0 - fog));
  }
}`;

class FoliageBlobEffectImpl extends Effect {
  constructor(_: object = {}) {
    super('FoliageBlob', FOL_BLOB_FRAG, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, THREE.Uniform<unknown>>([
        ['uTipCount',   new THREE.Uniform(0)],
        ['uTipPos',     new THREE.Uniform(new Float32Array(MAX_FOL_TIPS * 3))],
        ['uTipNDC',     new THREE.Uniform(new Float32Array(MAX_FOL_TIPS * 3))],
        ['uTipScreenR', new THREE.Uniform(new Float32Array(MAX_FOL_TIPS))],
        ['uTipCamDist', new THREE.Uniform(new Float32Array(MAX_FOL_TIPS))],
        ['uTipColor',   new THREE.Uniform(new Float32Array(MAX_FOL_TIPS * 3))],
        ['uDepthRange', new THREE.Uniform(new THREE.Vector2(0, 1))],
        ['uAspect',     new THREE.Uniform(1.0)],
        ['uFogNear',    new THREE.Uniform(180.0)],
        ['uFogFar',     new THREE.Uniform(700.0)],
        ['uFogColor',   new THREE.Uniform(new THREE.Color(0x02A9EA))],
      ]),
    });
  }
  override update(_renderer: unknown, _inputBuffer: unknown, _deltaTime: unknown): void {
    this.uniforms.get('uTipCount')!.value = _folTips.count;
    (this.uniforms.get('uTipPos')!.value     as Float32Array).set(_folTips.pos);
    (this.uniforms.get('uTipNDC')!.value     as Float32Array).set(_folTips.ndc);
    (this.uniforms.get('uTipScreenR')!.value as Float32Array).set(_folTips.screenR);
    (this.uniforms.get('uTipCamDist')!.value as Float32Array).set(_folTips.camDist);
    (this.uniforms.get('uTipColor')!.value   as Float32Array).set(_folTips.color);
    const dr = this.uniforms.get('uDepthRange')!.value as THREE.Vector2;
    dr.x = _folTips.depthRange[0]; dr.y = _folTips.depthRange[1];
    const canvas = document.querySelector('canvas');
    if (canvas) this.uniforms.get('uAspect')!.value = canvas.width / canvas.height;
  }
}
const FoliageBlobEffect = wrapEffect(FoliageBlobEffectImpl);

function MapBranchManager({ handle, clearHandle, onClearDone, spawnEnabled, difficulty, panelOccupied, playerMoveDirRef }: {
  handle: React.MutableRefObject<EnemyHandle>;
  clearHandle: React.MutableRefObject<ClearableHandle>;
  onClearDone: React.MutableRefObject<() => void>;
  spawnEnabled: React.MutableRefObject<boolean>;
  difficulty: React.MutableRefObject<Difficulty>;
  panelOccupied: React.MutableRefObject<Set<number>>;
  playerMoveDirRef: React.MutableRefObject<[number, number]>;
}) {
  const meshRef    = useRef<THREE.InstancedMesh>(null);
  const subRef     = useRef<THREE.InstancedMesh>(null);
  const leafRef    = useRef<THREE.InstancedMesh>(null);
  const slots      = useRef<BranchSlot[]>([]);
  const lastSpawnMs = useRef(0);
  const bendDirty   = useRef(false);

  // Shared Float32Array buffers for per-instance bend data.
  const bendBuf    = useRef(new Float32Array(BRANCH_POOL * 4));
  const axisBuf    = useRef(new Float32Array(BRANCH_POOL * 4));
  const subBendBuf = useRef(new Float32Array(BRANCH_POOL * SUB_PER_BRANCH * 4));
  const subAxisBuf = useRef(new Float32Array(BRANCH_POOL * SUB_PER_BRANCH * 4));

  const FOG_U = () => ({
    uFogColor: { value: new THREE.Color(0x02A9EA) },
    uFogNear:  { value: 180 },
    uFogFar:   { value: 700 },
  });

  // Branch trunk geometry: base at y=0, tip at y=1 — instance position = branch base.
  const branchGeo = useMemo(() => {
    const g = new THREE.CylinderGeometry(0, 1, 1, 8, 20);
    g.translate(0, 0.5, 0);
    g.setAttribute('aBend',     new THREE.InstancedBufferAttribute(bendBuf.current, 4));
    g.setAttribute('aBendAxis', new THREE.InstancedBufferAttribute(axisBuf.current, 4));
    return g;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const subGeo = useMemo(() => {
    const g = new THREE.CylinderGeometry(0, 1, 1, 6, 10);
    g.translate(0, 0.5, 0);
    g.setAttribute('aBend',     new THREE.InstancedBufferAttribute(subBendBuf.current, 4));
    g.setAttribute('aBendAxis', new THREE.InstancedBufferAttribute(subAxisBuf.current, 4));
    return g;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Single quad — position/orientation of each leaf encoded in its instance matrix.
  const leafGeo = useMemo(() => buildLeafQuadGeo(), []);

  const branchMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: BRANCH_VERT, fragmentShader: BRANCH_FRAG,
    uniforms: FOG_U(), side: THREE.DoubleSide,
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const subMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: BRANCH_VERT, fragmentShader: BRANCH_FRAG,
    uniforms: FOG_U(), side: THREE.DoubleSide,
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const leafMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: LEAF_VERT, fragmentShader: LEAF_FRAG,
    uniforms: FOG_U(), side: THREE.DoubleSide, transparent: true,
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Gradient generated once at mount — one color per pool slot.
  const leafGradient = useMemo(() => buildLeafGradient(BRANCH_POOL), []);

  useLayoutEffect(() => {
    const arr: BranchSlot[] = [];
    for (let i = 0; i < BRANCH_POOL; i++)
      arr.push({
        active:false, localX:0, z:SPAWN_Z, y:1, vx:0, vz:0, baseVz:0, radius:1, meshIdx:i, clearing:false, clearStart:0,
        b1:0, b2:0, a1:0, a2:0,
        spawnWX: 0, spawnWY: 0, spawnQuat: new THREE.Quaternion(),
        foliageCount: 0,
        foliageLocalOffs: Array.from({length: FOL_MAX}, () => new THREE.Vector3()),
        foliageSizes: new Array(FOL_MAX).fill(1),
        subLocalOffs: Array.from({length: SUB_PER_BRANCH}, () => new THREE.Vector3()),
        subLocalDirs: Array.from({length: SUB_PER_BRANCH}, () => new THREE.Vector3(0,1,0)),
        subHeight: new Array(SUB_PER_BRANCH).fill(0),
        subRadius: new Array(SUB_PER_BRANCH).fill(0),
        leafData: new Float32Array(LEAVES_PER_BRANCH * 4),
      });
    slots.current = arr;

    // Branches are scenery — handle/clearHandle are no-ops.
    handle.current      = { slots: arr, pushSlot: () => {} };
    clearHandle.current = { startClear() { onClearDone.current(); } };

    _mat4.makeScale(0, 0, 0);
    const mesh = meshRef.current, sub = subRef.current, lf = leafRef.current;
    for (let i = 0; i < BRANCH_POOL; i++)               mesh?.setMatrixAt(i, _mat4);
    for (let i = 0; i < BRANCH_POOL * SUB_PER_BRANCH; i++) sub?.setMatrixAt(i, _mat4);
    for (let i = 0; i < BRANCH_POOL * LEAVES_PER_BRANCH; i++) lf?.setMatrixAt(i, _mat4);
    if (mesh) mesh.instanceMatrix.needsUpdate = true;
    if (sub)  sub.instanceMatrix.needsUpdate  = true;
    if (lf)   lf.instanceMatrix.needsUpdate   = true;

    return () => { handle.current = { slots:[], pushSlot:()=>{} }; };
  }, [handle, clearHandle, onClearDone]); // eslint-disable-line react-hooks/exhaustive-deps

  function activateBend(s: BranchSlot) {
    const i = s.meshIdx;
    const h = s.radius * BRANCH_HEIGHT_MULT;
    const leafCol = leafGradient[i % leafGradient.length];
    s.b1 = rnd(0.25, 0.55); s.b2 = rnd(0.15, 0.45);
    // Orient primary bend axis toward player movement direction (branches lean toward far/sun)
    const [mvX, mvZ] = playerMoveDirRef.current;
    const sunAngle = Math.atan2(-mvX, mvZ);
    s.a1 = sunAngle + rnd(-Math.PI * 0.1, Math.PI * 0.1);
    s.a2 = rnd(0, Math.PI * 2);
    bendBuf.current[i*4+0] = s.b1; bendBuf.current[i*4+1] = s.b2;
    bendBuf.current[i*4+2] = 0;    bendBuf.current[i*4+3] = h;
    axisBuf.current[i*4+0] = s.a1; axisBuf.current[i*4+1] = s.a2;
    axisBuf.current[i*4+2] = 0;    axisBuf.current[i*4+3] = s.radius;
    for (let k = 0; k < SUB_PER_BRANCH; k++) {
      // Distribute evenly along the spine with a small random jitter per slot
      const band = (k + 0.5 + rnd(-0.3, 0.3)) / SUB_PER_BRANCH;
      const forkH = 0.15 + band * 0.75; // spans 0.15 → 0.90
      const [px,py,pz] = jsSpinePos(forkH, s.b1, s.b2, s.a1, s.a2);
      s.subLocalOffs[k].set(px * h, py * h, pz * h);
      const [dx,dy,dz] = jsSpineDir(forkH, s.b1, s.b2, s.a1, s.a2);
      s.subLocalDirs[k].set(dx, dy*0.55, dz).normalize();
      s.subHeight[k] = h * rnd(0.38, 0.55);
      s.subRadius[k] = s.radius * rnd(0.28, 0.42);
      const si = i * SUB_PER_BRANCH + k;
      subBendBuf.current[si*4+0] = rnd(0.2,0.5); subBendBuf.current[si*4+1] = rnd(0.1,0.3);
      subBendBuf.current[si*4+2] = 0;             subBendBuf.current[si*4+3] = s.subHeight[k];
      subAxisBuf.current[si*4+0] = rnd(0,Math.PI*2); subAxisBuf.current[si*4+1] = rnd(0,Math.PI*2);
      subAxisBuf.current[si*4+2] = 0;                subAxisBuf.current[si*4+3] = s.subRadius[k];
    }
    // 4/20 branches get no foliage spheres; others get 1–FOL_MAX spheres
    s.foliageCount = Math.random() < 4 / 20 ? 0 : 1 + Math.floor(Math.random() * FOL_MAX);
    for (let k = 0; k < s.foliageCount; k++) {
      const fh = 0.88 + k * (0.07 / Math.max(1, s.foliageCount - 1)); // tip only: 0.88–0.95
      const [fpx, fpy, fpz] = jsSpinePos(Math.min(fh, 0.95), s.b1, s.b2, s.a1, s.a2);
      s.foliageLocalOffs[k].set(fpx * h, fpy * h, fpz * h);
      s.foliageSizes[k] = (h * 0.18 + s.radius * 3.5) * rnd(0.7, 1.4);
    }

    // Pre-compute per-leaf (h, radAng, sz, tilt) in clusters along the spine.
    // Each cluster groups nearby height values — leaves form tufts on the branch.
    for (let c = 0; c < BRANCH_LEAF_CLUSTERS; c++) {
      const band   = (c + 0.5 + rnd(-0.2, 0.2)) / BRANCH_LEAF_CLUSTERS;
      const clH    = 0.18 + band * 0.78;           // span: 0.18 → 0.96
      const clAng  = rnd(0, Math.PI * 2);           // cluster radial center
      for (let l = 0; l < BRANCH_LEAVES_PER_CL; l++) {
        const li = c * BRANCH_LEAVES_PER_CL + l;
        if (li >= LEAVES_PER_BRANCH) break;
        const leafH   = Math.min(clH + rnd(-0.04, 0.04), 0.96);
        const radAng  = clAng + rnd(-0.6, 0.6);    // leaves spread radially around cluster
        const sz      = rnd(0.5, 1.8) * s.radius * 0.6;
        const tilt    = 0.3 + Math.random() * 0.6;
        s.leafData[li*4]   = leafH;
        s.leafData[li*4+1] = radAng;
        s.leafData[li*4+2] = sz;
        s.leafData[li*4+3] = tilt;
      }
    }

    // Set per-leaf instance colors (all leaves of a branch share the branch palette color).
    const lf = leafRef.current;
    if (lf) {
      const base = i * LEAVES_PER_BRANCH;
      for (let li = 0; li < LEAVES_PER_BRANCH; li++) lf.setColorAt(base + li, leafCol);
      if (lf.instanceColor) lf.instanceColor.needsUpdate = true;
    }

    bendDirty.current = true;
  }

  const ROAD_HALF_X = LANE_X[LANE_X.length - 1] + LANE_WIDTH;
  const MAX_ROAD_BRANCHES = 3;
  const MAX_ROAD_ROUND    = MIN_ACTIVE + 19 * 4; // maxEnemies at round 20

  function spawnOne(spawnT: number, sizeScale: number) {
    const slot = slots.current.find(s => !s.active) as BranchSlot | undefined; if (!slot) return;
    const r  = (ENM_MIN_R + (ENM_MAX_R - ENM_MIN_R) * Math.random() ** 1.5) * sizeScale;

    // Road-branch probability: 3% → 20% with difficulty, max 3 simultaneous on-road branches
    const activeRoad = slots.current.filter(s => s.active && Math.abs(s.localX) <= ROAD_HALF_X).length;
    const rampT      = Math.min(1, Math.max(0, (difficulty.current.maxEnemies - MIN_ACTIVE) / (MAX_ROAD_ROUND - MIN_ACTIVE)));
    const roadProb   = 0.03 + rampT * 0.17;
    const spawnOnRoad = activeRoad < MAX_ROAD_BRANCHES && Math.random() < roadProb;

    let lx: number;
    if (spawnOnRoad) {
      // Pick a lane not currently occupied by a verse panel
      const occ = panelOccupied.current;
      const freeLanes = LANE_X.filter((laneX) => {
        const nearSlot = PANEL_SLOT_X.reduce((best, px, pi) =>
          Math.abs(px - laneX) < Math.abs(PANEL_SLOT_X[best] - laneX) ? pi : best, 0);
        return !occ.has(nearSlot);
      });
      const pool = freeLanes.length > 0 ? freeLanes : [...LANE_X];
      lx = pool[Math.floor(Math.random() * pool.length)] + rnd(-1, 1);
    } else {
      // Off-road
      lx = Math.random() < 0.5 ? rnd(-200, -ROAD_HALF_X - 1) : rnd(ROAD_HALF_X + 1, 200);
    }

    const sz = SPAWN_Z - rnd(0, 60);
    // Visual cylinder surface = terrainY (bumps + cylinder arc) with roll/yaw applied.
    // Phase invariance: every wave has phase velocity 100 u/s = vz, so the frozen world
    // position matches the cylinder surface at every future Z as the branch scrolls.
    const ty = terrainY(lx, sz, spawnT);
    surfaceQuat(lx, sz, spawnT, slot.spawnQuat);
    const [wx, wy] = applyRollYaw(lx, ty, spawnT, sz);
    slot.spawnWX = wx; slot.spawnWY = wy;
    slot.active = true; slot.localX = lx; slot.z = sz; slot.clearing = false;
    slot.radius = r;
    slot.y = wy + r * BRANCH_HEIGHT_MULT * 0.5;
    slot.baseVz = 100; slot.vz = 100; slot.vx = 0;
    activateBend(slot);
  }

  useFrame((state, delta) => {
    const t   = state.clock.getElapsedTime();
    const now = performance.now();
    const arr = slots.current;
    const imesh = meshRef.current; if (!imesh) return;
    const isub  = subRef.current;
    const ilf   = leafRef.current;
    _folTips.count = 0;

    let activeCount = 0;
    for (const _s of arr) {
      const s = _s as BranchSlot;
      if (!s.active) continue;

      // Scroll in Z at fixed terrain speed. No lateral movement.
      s.z += s.vz * delta;

      // Recycle when past camera — hide trunk, subs, and all leaf instances.
      if (s.z > ELIM_BOT_Z) {
        s.active = false;
        _mat4.makeScale(0,0,0);
        imesh.setMatrixAt(s.meshIdx, _mat4);
        for (let k=0; k<SUB_PER_BRANCH; k++) isub?.setMatrixAt(s.meshIdx*SUB_PER_BRANCH+k, _mat4);
        if (ilf) {
          const base = s.meshIdx * LEAVES_PER_BRANCH;
          for (let li = 0; li < LEAVES_PER_BRANCH; li++) ilf.setMatrixAt(base + li, _mat4);
        }
        continue;
      }

      activeCount++;

      // Position and orientation frozen at spawn — only Z scrolls.
      _squat.copy(s.spawnQuat);
      const twx = s.spawnWX, twy = s.spawnWY;

      _mat4.makeRotationFromQuaternion(_squat);
      _mat4.setPosition(twx, twy, s.z);
      imesh.setMatrixAt(s.meshIdx, _mat4);

      // Per-leaf instances — skip entirely if branch is in fog.
      if (ilf) {
        const h = s.radius * BRANCH_HEIGHT_MULT;
        const branchCamDist = state.camera.position.distanceTo(_pos3.set(twx, twy, s.z));
        const base = s.meshIdx * LEAVES_PER_BRANCH;
        if (branchCamDist > 320) {
          _mat4.makeScale(0, 0, 0);
          for (let li = 0; li < LEAVES_PER_BRANCH; li++) ilf.setMatrixAt(base + li, _mat4);
        } else {
          // Branch world matrix (rotation + position) — used to transform leaf local frames.
          _branchM.makeRotationFromQuaternion(_squat);
          _branchM.setPosition(twx, twy, s.z);
          for (let li = 0; li < LEAVES_PER_BRANCH; li++) {
            const leafH   = s.leafData[li*4];
            const radAng  = s.leafData[li*4+1];
            const sz      = s.leafData[li*4+2];
            const tilt    = s.leafData[li*4+3];
            // Mirror LEAF_VERT: compute leaf frame in branch-local space
            const [spx, spy, spz] = jsSpinePos(leafH, s.b1, s.b2, s.a1, s.a2);
            const [tdx, tdy, tdz] = jsSpineDir(leafH, s.b1, s.b2, s.a1, s.a2);
            _lTang.set(tdx, tdy, tdz).normalize();
            const upRef = Math.abs(_lTang.y) < 0.9 ? _worldUp2 : new THREE.Vector3(1,0,0);
            _lRight.crossVectors(upRef, _lTang).normalize();
            _lFwd.crossVectors(_lTang, _lRight);
            _lOut.set(
              _lRight.x * Math.cos(radAng) + _lFwd.x * Math.sin(radAng),
              _lRight.y * Math.cos(radAng) + _lFwd.y * Math.sin(radAng),
              _lRight.z * Math.cos(radAng) + _lFwd.z * Math.sin(radAng),
            );
            _lUp.set(
              _lTang.x * (1 - tilt) + _lOut.x * tilt,
              _lTang.y * (1 - tilt) + _lOut.y * tilt,
              _lTang.z * (1 - tilt) + _lOut.z * tilt,
            ).normalize();
            _lR.crossVectors(_lUp, _lOut).normalize();
            // Leaf center in branch-local space (spine position + radial offset × base radius)
            _lCenter.set(
              spx * h + _lOut.x * s.radius * 0.35,
              spy * h + _lOut.y * s.radius * 0.35,
              spz * h + _lOut.z * s.radius * 0.35,
            );
            // Build leaf local matrix: basis (leafR, leafUp, leafOut) + scale + position
            _leafM.makeBasis(_lR, _lUp, _lOut);
            _leafM.scale(_scale.set(sz, sz, sz));
            _leafM.setPosition(_lCenter);
            // Apply branch world transform
            _mat4f.multiplyMatrices(_branchM, _leafM);
            ilf.setMatrixAt(base + li, _mat4f);
          }
        }
      }

      // Write foliage tip positions to shared buffer for FoliageBlobEffect
      for (let k = 0; k < s.foliageCount && _folTips.count < MAX_FOL_TIPS; k++) {
        const fi = _folTips.count++;
        _tmpV3.copy(s.foliageLocalOffs[k]).applyQuaternion(_squat);
        const wpx = twx + _tmpV3.x;
        const wpy = twy + _tmpV3.y;
        const wpz = s.z  + _tmpV3.z;
        _folTips.pos[fi*3]   = wpx;
        _folTips.pos[fi*3+1] = wpy;
        _folTips.pos[fi*3+2] = wpz;
        // Project to NDC for screen-space shader
        _pos3.set(wpx, wpy, wpz).project(state.camera);
        _folTips.ndc[fi*3]   = _pos3.x;
        _folTips.ndc[fi*3+1] = _pos3.y;
        _folTips.ndc[fi*3+2] = _pos3.z;
        // Screen-space radius and camera distance
        const camDist = Math.max(0.1, state.camera.position.distanceTo(_tmpV3.set(wpx, wpy, wpz)));
        _folTips.screenR[fi]  = (s.foliageSizes[k] / camDist) * (state.camera as THREE.PerspectiveCamera).projectionMatrix.elements[5];
        _folTips.camDist[fi]  = camDist;
        const col = leafGradient[s.meshIdx % leafGradient.length];
        _folTips.color[fi*3]   = col.r;
        _folTips.color[fi*3+1] = col.g;
        _folTips.color[fi*3+2] = col.b;
      }

      for (let k = 0; k < SUB_PER_BRANCH; k++) {
        _tmpV3.copy(s.subLocalOffs[k]).applyQuaternion(_squat);
        _pos3.set(twx + _tmpV3.x, twy + _tmpV3.y, s.z + _tmpV3.z);
        _tmpV3.copy(s.subLocalDirs[k]).applyQuaternion(_squat);
        _subQuat.setFromUnitVectors(_worldUp2, _tmpV3.normalize());
        _mat4f.makeRotationFromQuaternion(_subQuat);
        _mat4f.setPosition(_pos3);
        isub?.setMatrixAt(s.meshIdx * SUB_PER_BRANCH + k, _mat4f);
      }
    }

    if (spawnEnabled.current && now - lastSpawnMs.current > SPAWN_INTERVAL_MS && activeCount < MIN_ACTIVE) {
      spawnOne(t, difficulty.current.enemySizeScale); lastSpawnMs.current = now;
    }

    imesh.instanceMatrix.needsUpdate = true;
    isub && (isub.instanceMatrix.needsUpdate = true);
    ilf  && (ilf.instanceMatrix.needsUpdate  = true);

    // Compute depth range + sort tips farthest-first (painter's algorithm: close blobs overwrite far)
    if (_folTips.count > 0) {
      const n = _folTips.count;
      let dMin = Infinity, dMax = 0;
      for (let fi = 0; fi < n; fi++) {
        _folTips._sortIdx[fi] = fi;
        const d = _folTips.camDist[fi];
        if (d < dMin) dMin = d;
        if (d > dMax) dMax = d;
      }
      _folTips.depthRange[0] = dMin;
      _folTips.depthRange[1] = dMax;
      // Sort indices descending by camDist (farthest first → shader processes close tips last)
      const idx = _folTips._sortIdx.subarray(0, n);
      idx.sort((a, b) => _folTips.camDist[b] - _folTips.camDist[a]);
      // Reorder all tip arrays into scratch buffers then copy back
      for (let si = 0; si < n; si++) {
        const src = idx[si];
        _folTips._tmpDist[si]     = _folTips.camDist[src];
        _folTips._tmpScrR[si]     = _folTips.screenR[src];
        _folTips._tmpPos[si*3]    = _folTips.pos[src*3];
        _folTips._tmpPos[si*3+1]  = _folTips.pos[src*3+1];
        _folTips._tmpPos[si*3+2]  = _folTips.pos[src*3+2];
        _folTips._tmpNdc[si*3]    = _folTips.ndc[src*3];
        _folTips._tmpNdc[si*3+1]  = _folTips.ndc[src*3+1];
        _folTips._tmpNdc[si*3+2]  = _folTips.ndc[src*3+2];
        _folTips._tmpCol[si*3]    = _folTips.color[src*3];
        _folTips._tmpCol[si*3+1]  = _folTips.color[src*3+1];
        _folTips._tmpCol[si*3+2]  = _folTips.color[src*3+2];
      }
      _folTips.camDist.set(_folTips._tmpDist.subarray(0, n));
      _folTips.screenR.set(_folTips._tmpScrR.subarray(0, n));
      _folTips.pos.set(_folTips._tmpPos.subarray(0, n*3));
      _folTips.ndc.set(_folTips._tmpNdc.subarray(0, n*3));
      _folTips.color.set(_folTips._tmpCol.subarray(0, n*3));
    }

    if (bendDirty.current) {
      bendDirty.current = false;
      (branchGeo.getAttribute('aBend')     as THREE.InstancedBufferAttribute).needsUpdate = true;
      (branchGeo.getAttribute('aBendAxis') as THREE.InstancedBufferAttribute).needsUpdate = true;
      (subGeo.getAttribute('aBend')        as THREE.InstancedBufferAttribute).needsUpdate = true;
      (subGeo.getAttribute('aBendAxis')    as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
  });

  return (
    <>
      <instancedMesh ref={meshRef} args={[branchGeo, branchMat, BRANCH_POOL]}                  frustumCulled={false} />
      <instancedMesh ref={subRef}  args={[subGeo,    subMat,    BRANCH_POOL * SUB_PER_BRANCH]}  frustumCulled={false} />
      <instancedMesh ref={leafRef} args={[leafGeo,   leafMat,   BRANCH_POOL * LEAVES_PER_BRANCH]} frustumCulled={false} />
    </>
  );
}

// ── BoxObstacleManager ────────────────────────────────────────────────────────

type BoxSlot = { active: boolean; localX: number; z: number; meshIdx: number; clearing: boolean; clearStart: number };

function BoxObstacleManager({ playerPosRef, onHit, clearHandle, onClearDone, spawnEnabled, difficulty }: {
  playerPosRef: React.MutableRefObject<Map<string, THREE.Vector3>>;
  onHit: (id: string, nx: number) => void;
  clearHandle: React.MutableRefObject<ClearableHandle>;
  onClearDone: React.MutableRefObject<() => void>;
  spawnEnabled: React.MutableRefObject<boolean>;
  difficulty: React.MutableRefObject<Difficulty>;
}) {
  const meshRef       = useRef<THREE.InstancedMesh>(null);
  const slots         = useRef<BoxSlot[]>([]);
  const lastSpawnMs   = useRef(0);
  const isClearingRef = useRef(false);

  useLayoutEffect(() => {
    const arr: BoxSlot[] = [];
    for (let i = 0; i < BOX_POOL; i++) arr.push({ active:false, localX:0, z:SPAWN_Z, meshIdx:i, clearing:false, clearStart:0 });
    slots.current = arr;

    clearHandle.current = {
      startClear() {
        const active = arr.filter(s => s.active && !s.clearing);
        if (active.length === 0) { onClearDone.current(); return; }
        const now = performance.now();
        active.forEach(s => { s.clearing = true; s.clearStart = now; });
        isClearingRef.current = true;
      },
    };

    const imesh = meshRef.current; if (!imesh) return;
    _mat4.makeScale(0, 0, 0);
    for (let i = 0; i < BOX_POOL; i++) imesh.setMatrixAt(i, _mat4);
    imesh.instanceMatrix.needsUpdate = true;
  }, [clearHandle, onClearDone]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((state, delta) => {
    const t     = state.clock.getElapsedTime();
    const now   = performance.now();
    const imesh = meshRef.current; if (!imesh) return;
    const arr   = slots.current;

    for (const s of arr) {
      if (!s.active) { _mat4.makeScale(0,0,0); imesh.setMatrixAt(s.meshIdx, _mat4); continue; }

      if (s.clearing) {
        const ct = Math.min(1, (now - s.clearStart) / CLEAR_MS);
        if (ct >= 1) {
          s.active = false; _mat4.makeScale(0,0,0); imesh.setMatrixAt(s.meshIdx, _mat4);
        } else {
          const scY = 1 - ct;
          const localWy = terrainY(s.localX, s.z, t) + BOX_H / 2 * scY;
          const [wx, wy] = applyRollYaw(s.localX, localWy, t, s.z);
          _scale.set(1, scY, 1); _pos3.set(wx, wy, s.z);
          _mat4.compose(_pos3, surfaceQuat(s.localX, s.z, t, _squat), _scale);
          imesh.setMatrixAt(s.meshIdx, _mat4);
        }
        continue;
      }

      s.z += PANEL_SPEED * delta;
      if (s.z > ELIM_BOT_Z) { s.active = false; continue; }

      const localWy = terrainY(s.localX, s.z, t) + BOX_H / 2;
      const [wx, wy] = applyRollYaw(s.localX, localWy, t, s.z);

      for (const [id, wpos] of playerPosRef.current) {
        const dx = wpos.x - s.localX, dz = wpos.z - s.z;
        const hw = BOX_W / 2 + P_RADIUS, hd = BOX_D / 2 + P_RADIUS;
        if (Math.abs(dx) < hw && Math.abs(dz) < hd && Math.abs(wpos.y - wy) < BOX_H / 2 + P_RADIUS) {
          const nx = dx >= 0 ? 1 : -1;
          onHit(id, nx * 18);
        }
      }

      _scale.set(1, 1, 1);
      _pos3.set(wx, wy, s.z);
      _mat4.compose(_pos3, surfaceQuat(s.localX, s.z, t, _squat), _scale);
      imesh.setMatrixAt(s.meshIdx, _mat4);
    }

    if (isClearingRef.current && !arr.some(s => s.active)) {
      isClearingRef.current = false;
      onClearDone.current();
    }

    const activeBoxes = arr.filter(s => s.active).length;
    if (spawnEnabled.current && activeBoxes < difficulty.current.maxBoxes && now - lastSpawnMs.current > 4000) {
      const slot = arr.find(s => !s.active);
      if (slot) { slot.active = true; slot.localX = randLane() + rnd(-2, 2); slot.z = SPAWN_Z; slot.clearing = false; }
      lastSpawnMs.current = now;
    }

    imesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, BOX_POOL]}>
      <boxGeometry args={[BOX_W, BOX_H, BOX_D]} />
      <meshStandardMaterial color={0x334455} metalness={0.6} roughness={0.3} />
    </instancedMesh>
  );
}

// ── BeamManager ───────────────────────────────────────────────────────────────

const BEAM_VERT = /* glsl */`
varying vec2 vUv;
void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}
`;
const BEAM_FRAG = /* glsl */`
uniform sampler2D u_tex; uniform float u_opacity,u_scroll;
varying vec2 vUv;
vec3 rgb2hsv(vec3 c){vec4 K=vec4(0.,-1./3.,2./3.,-1.);vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));float d=q.x-min(q.w,q.y);return vec3(abs(q.z+(q.w-q.y)/(6.*d+1e-10)),d/(q.x+1e-10),q.x);}
vec3 hsv2rgb(vec3 c){vec4 K=vec4(1.,2./3.,1./3.,3.);vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www);return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y);}
void main(){
  float phase=fract(vUv.y*4.0-u_scroll),onDuty=0.62;
  float mask=smoothstep(0.,0.08,phase)*(1.-smoothstep(onDuty,onDuty+0.06,phase));
  if(mask<0.01)discard;
  vec4 col=texture2D(u_tex,vec2(vUv.x,clamp(phase/onDuty,0.,1.)));
  vec3 hsv=rgb2hsv(col.rgb);hsv.x=fract(hsv.x+30./360.);col.rgb=hsv2rgb(hsv);
  col.a*=u_opacity*mask; if(col.a<0.005)discard; gl_FragColor=col;
}
`;

const BEAM_W = 0.9;
type BeamRecord = { mesh:THREE.Mesh; mat:THREE.ShaderMaterial; born:number; scroll:number; from:THREE.Vector3; norm:THREE.Vector3; length:number };

function BeamManager({ spawnRef }: { spawnRef: React.MutableRefObject<SpawnBeam> }) {
  const groupRef = useRef<THREE.Group>(null);
  const beams    = useRef<BeamRecord[]>([]);
  const texRef   = useRef<THREE.Texture | null>(null);
  const _va = new THREE.Vector3(), _vb = new THREE.Vector3(),
        _vc = new THREE.Vector3(), _vd = new THREE.Vector3(), _m4 = new THREE.Matrix4();

  useLayoutEffect(() => {
    new THREE.TextureLoader().load('/beams/image.png', tex => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping; texRef.current = tex;
    });
  }, []);

  useLayoutEffect(() => {
    spawnRef.current = (from, to) => {
      const group = groupRef.current; if (!group) return;
      const dir = to.clone().sub(from), length = Math.max(dir.length(), 0.1);
      const mat = new THREE.ShaderMaterial({
        vertexShader:BEAM_VERT, fragmentShader:BEAM_FRAG,
        uniforms:{u_tex:{value:texRef.current},u_opacity:{value:1},u_scroll:{value:0}},
        transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(BEAM_W, length), mat);
      group.add(mesh);
      beams.current.push({mesh,mat,born:performance.now(),scroll:0,from:from.clone(),norm:dir.clone().normalize(),length});
    };
    return () => { spawnRef.current = ()=>{}; };
  }, [spawnRef]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((state, delta) => {
    const now=performance.now(); const cam=state.camera.position;
    beams.current = beams.current.filter(b => {
      const age=now-b.born;
      if(age>=BEAM_TTL_MS){groupRef.current?.remove(b.mesh);b.mesh.geometry.dispose();b.mat.dispose();return false;}
      b.scroll+=delta*1.8; b.mat.uniforms.u_scroll.value=b.scroll;
      b.mat.uniforms.u_opacity.value=Math.sin(age/BEAM_TTL_MS*Math.PI);
      if(!b.mat.uniforms.u_tex.value&&texRef.current) b.mat.uniforms.u_tex.value=texRef.current;
      const mid=_va.copy(b.from).addScaledVector(b.norm,b.length/2);
      _vb.copy(cam).sub(mid).normalize();
      _vc.crossVectors(b.norm,_vb); if(_vc.lengthSq()<1e-6)return true; _vc.normalize();
      _vd.crossVectors(_vc,b.norm).normalize();
      _m4.set(_vc.x,b.norm.x,_vd.x,mid.x,_vc.y,b.norm.y,_vd.y,mid.y,_vc.z,b.norm.z,_vd.z,mid.z,0,0,0,1);
      b.mesh.position.copy(mid); b.mesh.quaternion.setFromRotationMatrix(_m4);
      return true;
    });
  });
  return <group ref={groupRef} />;
}

function publishVibrate(roomId: string, controllerId: string) {
  if (!isGamesStompConnected()) return;
  const durationMs = Math.round(HIT_ANIM.frames / HIT_ANIM.fps * 1000);
  getGamesStompClient().publish({
    destination: `/topic/room/${roomId}`,
    body: JSON.stringify({ type: 'vibrate', controllerId, durationMs }),
  });
}

// ── PlayerSphereBody ──────────────────────────────────────────────────────────

interface PlayerBodyProps {
  controller: ControllerDisplay;
  inputsMap: React.MutableRefObject<Map<string, ControllerState>>;
  enemyHandle: React.MutableRefObject<EnemyHandle>;
  spawnBeam: React.MutableRefObject<SpawnBeam>;
  playerPosRef: React.MutableRefObject<Map<string, THREE.Vector3>>;
  roomId: string;
  boxHitRef: React.MutableRefObject<Map<string, number>>;
  zoneHandle: React.MutableRefObject<ZoneHandle>;
  playerMoveDirRef: React.MutableRefObject<[number, number]>;
  color: string;
  initPos: [number, number, number];
}

function PlayerSphereBody({ controller, inputsMap, enemyHandle, spawnBeam, playerPosRef, boxHitRef, zoneHandle, playerMoveDirRef, initPos, roomId }: PlayerBodyProps) {
  const meshRef    = useRef<THREE.Mesh>(null);
  const labelRef   = useRef<THREE.Group>(null);
  const ringRef    = useRef<THREE.Group>(null);
  const ringMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const pos        = useRef(new THREE.Vector3(...initPos));
  const velX       = useRef(0);
  const velY       = useRef(0);
  const velZ       = useRef(0);
  const onGround   = useRef(false);
  const jumpCount  = useRef(0);
  const prevA      = useRef(false);
  const prevB      = useRef(false);
  const dashUntil  = useRef(0);
  const dashRef    = useRef<{ dist: number; dir: [number, number] } | null>(null);
  const fireTimer  = useRef(0);
  const aimDir     = useRef<[number, number]>([0, -1]);
  const invUntil   = useRef(performance.now() + INVINCIBLE_MS);
  const worldPos   = useRef(new THREE.Vector3());

  useLayoutEffect(() => {
    playerPosRef.current.set(controller.id, worldPos.current);
    return () => { playerPosRef.current.delete(controller.id); };
  }, [controller.id, playerPosRef]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((state, delta) => {
    const t     = state.clock.getElapsedTime();
    const input = inputsMap.current.get(controller.id);
    const now   = performance.now();
    const p     = pos.current;

    const floorY = terrainY(p.x, p.z, t) + P_RADIUS;

    // Gravity
    velY.current -= 30 * delta;
    p.y += velY.current * delta;
    if (p.y <= floorY) {
      p.y = floorY; if (velY.current < 0) velY.current = 0;
      onGround.current = true; jumpCount.current = 0;
    } else { onGround.current = false; }

    // Respawn
    if (p.y < terrainY(p.x, p.z, t) - 15) {
      p.set(randLane(), floorY, (ZONE_MIN_Z + ZONE_MAX_Z) / 2);
      velX.current = 0; velY.current = 0; velZ.current = 0;
      jumpCount.current = 0; onGround.current = true;
      invUntil.current = now + INVINCIBLE_MS;
    }

    // Blink
    const isInvincible = now < invUntil.current;
    if (meshRef.current) meshRef.current.visible = !isInvincible || Math.floor(now / 120) % 2 === 0;

    // Box collision impulse
    const boxHit = boxHitRef.current.get(controller.id);
    if (boxHit !== undefined) {
      velX.current += boxHit;
      boxHitRef.current.delete(controller.id);
      SpriteAnimService.play(HIT_ANIM, p.x, p.y, p.z);
      publishVibrate(roomId, controller.id);
    }

    // Enemy collision (in local unrolled space)
    if (!isInvincible) {
      for (const s of enemyHandle.current.slots) {
        if (!s.active) continue;
        const dx   = p.x - s.localX, dy = p.y - s.y, dz = p.z - s.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const minD = P_RADIUS + s.radius;
        if (dist >= minD || dist < 0.01) continue;
        const nx = dx / dist, nz = dz / dist, pushF = 12 + s.radius * 4;
        velX.current += nx * pushF; velZ.current += nz * pushF;
        p.x += nx * (minD - dist); p.z += nz * (minD - dist);
        const wp = worldPos.current;
        SpriteAnimService.play(HIT_ANIM, wp.x, wp.y, wp.z);
        publishVibrate(roomId, controller.id);
      }
    }

    // Movement
    const stick  = input?.stick_center;
    const stickX = stick?.type === 'axis2d' ? stick.x  : 0;
    const stickY = stick?.type === 'axis2d' ? -stick.y : 0;

    velX.current = Math.abs(stickX) > 0.1 ? stickX * P_SPEED : velX.current * Math.exp(-FRICTION_RATE * delta);
    p.x += velX.current * delta;
    p.x  = Math.max(-LANE_BOUND_X, Math.min(LANE_BOUND_X, p.x));

    velZ.current = Math.abs(stickY) > 0.1 ? stickY * P_SPEED : velZ.current * Math.exp(-FRICTION_RATE * delta);
    p.z += velZ.current * delta;

    // Share normalised move direction for branch orientation
    const mvLen = Math.sqrt(velX.current * velX.current + velZ.current * velZ.current);
    if (mvLen > 0.5) {
      playerMoveDirRef.current[0] = velX.current / mvLen;
      playerMoveDirRef.current[1] = velZ.current / mvLen;
    }
    if (p.z < ZONE_MIN_Z)            { p.z = ZONE_MIN_Z;            velZ.current = Math.max(0, velZ.current); }
    if (p.z > ZONE_MAX_Z - P_RADIUS) { p.z = ZONE_MAX_Z - P_RADIUS; velZ.current = Math.min(0, velZ.current); }

    // Zone validate (A) — validate only, no jump
    const aDown = isPressed(input?.A);
    if (aDown && !prevA.current) {
      zoneHandle.current.tryValidate(controller.id, p.x, p.z);
    }
    prevA.current = aDown;

    // Dash (B) — ground only, sustained over DASH_DIST like Metel
    const bDown = isPressed(input?.B);
    if (bDown && !prevB.current && onGround.current && !dashRef.current && now >= dashUntil.current) {
      const dx = Math.abs(stickX) > 0.1 ? stickX : 0;
      const dz = Math.abs(stickY) > 0.1 ? stickY : -1;
      const len = Math.sqrt(dx * dx + dz * dz);
      const dir: [number, number] = len > 0.01 ? [dx / len, dz / len] : [0, -1];
      velX.current = dir[0] * DASH_SPEED;
      velZ.current = dir[1] * DASH_SPEED;
      dashRef.current = { dist: 0, dir };
    }
    if (dashRef.current) {
      const [ddx, ddz] = dashRef.current.dir;
      velX.current = ddx * DASH_SPEED;
      velZ.current = ddz * DASH_SPEED;
      dashRef.current.dist += DASH_SPEED * delta;
      if (dashRef.current.dist >= DASH_DIST) {
        dashRef.current = null;
        dashUntil.current = now + DASH_COOLDOWN_MS;
      }
    }
    prevB.current = bDown;

    // Aim
    const stickR = input?.stick_right;
    if (stickR?.type === 'axis2d') {
      const ax = stickR.x, az = -stickR.y, len = Math.sqrt(ax * ax + az * az);
      if (len > 0.15) aimDir.current = [ax / len, az / len];
    }

    // Fire
    const stickL  = input?.stick_left;
    const firingL = stickL?.type === 'axis2d' && Math.sqrt(stickL.x ** 2 + stickL.y ** 2) > 0.15;
    const firingR = stickR?.type === 'axis2d' && Math.sqrt(stickR.x ** 2 + stickR.y ** 2) > 0.15;
    const [rendX, rendY] = applyRollYaw(p.x, p.y, t, p.z);
    if (firingL || firingR) {
      fireTimer.current -= delta;
      if (fireTimer.current <= 0) {
        fireTimer.current = 1 / FIRE_HZ;
        const [adx, adz] = aimDir.current;
        const beamFrom = new THREE.Vector3(rendX + adx * P_RADIUS, rendY, p.z + adz * P_RADIUS);
        const beamEnd  = new THREE.Vector3(rendX + adx * BEAM_RANGE, rendY, p.z + adz * BEAM_RANGE);
        const eSlots = enemyHandle.current.slots;
        let closestDist = Infinity, closestIdx = -1;
        for (let i = 0; i < eSlots.length; i++) {
          const s = eSlots[i]; if (!s.active) continue;
          const [sx] = applyRollYaw(s.localX, s.y, t, s.z);
          const dx = sx - rendX, dy = s.y - p.y, dz = s.z - p.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist > BEAM_RANGE || dist < 0.01 || dist >= closestDist) continue;
          if (dx * adx + dz * adz <= 0) continue;
          const dist2d = Math.sqrt(dx * dx + dz * dz);
          const sin = Math.abs(dx * adz - dz * adx) / Math.max(dist2d, 0.01);
          if (sin > Math.sin(CONE_HALF + Math.asin(Math.min(s.radius / Math.max(dist, s.radius), 1)))) continue;
          closestDist = dist; closestIdx = i;
        }
        if (closestIdx >= 0) enemyHandle.current.pushSlot(closestIdx, adx * BEAM_PUSH * (1 - closestDist / BEAM_RANGE), adz * BEAM_PUSH * (1 - closestDist / BEAM_RANGE));
        spawnBeam.current(beamFrom, beamEnd);
      }
    } else { fireTimer.current = 0; }

    // worldPos in local space for zone detection; rendered position uses roll
    worldPos.current.set(p.x, p.y, p.z);

    if (meshRef.current)  meshRef.current.position.set(rendX, rendY, p.z);
    if (labelRef.current) labelRef.current.position.set(rendX, rendY + P_RADIUS + 0.8, p.z);

    // Ring on ground — follows player, colored by active zone
    if (ringRef.current) {
      const groundLocalY = terrainY(p.x, p.z, t);
      const [ringWx, ringWy] = applyRollYaw(p.x, groundLocalY, t, p.z);
      ringRef.current.position.set(ringWx, ringWy + 0.08, p.z);
      ringRef.current.quaternion.copy(surfaceQuat(p.x, p.z, t, _squat));
    }
    if (ringMatRef.current) {
      const zc = zoneHandle.current.getZoneColor(p.x, p.z);
      if (zc) ringMatRef.current.color.copy(zc);
      else    ringMatRef.current.color.set(0x666677);
    }
  });

  const matcap = useTexture('/assets/matcaps/unnamed/75746F_333330_A2A1A9_444444-64px.png');
  const name   = controller.pseudo || controller.id.slice(0, 8);

  return (
    <>
      <group ref={ringRef}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[P_RADIUS * 0.875, 0.15, 8, 36]} />
          <meshBasicMaterial ref={ringMatRef} color={0x666677} />
        </mesh>
      </group>
      <mesh ref={meshRef} castShadow>
        <sphereGeometry args={[P_RADIUS, 28, 20]} />
        <meshMatcapMaterial matcap={matcap} />
      </mesh>
      <group ref={labelRef}>
        <Html center style={{ pointerEvents:'none' }} zIndexRange={[1, 0]}>
          <span style={{ color:'#fff', fontFamily:'monospace', fontSize:13, fontWeight:700,
            textShadow:'0 0 5px #000,0 1px 3px #000', whiteSpace:'nowrap', userSelect:'none' }}>
            {name}
          </span>
        </Html>
      </group>
    </>
  );
}

// ── Anim definitions ──────────────────────────────────────────────────────────

const WRONG_ANSWER_ANIM: SpriteAnimDef = {
  sheet:       '/games/verse_battle/impact/sheet.png',
  frames:      5,
  cols:        5,
  fps:         30,
  scale:       [P_RADIUS * 2 * 3.5, P_RADIUS * 2 * 5.0],
  billboard:   true,
  randomRotation: true,
  renderOrder: 999,
  depthTest:   false,
};

const HIT_ANIM: SpriteAnimDef = {
  sheet:       '/games/verse_battle/impact/2_sheet.png',
  frames:      5,
  cols:        5,
  rows:        1,
  fps:         15,
  scale:       [P_RADIUS * 2 * 3.0, P_RADIUS * 2 * 4.5],
  billboard:   true,
  randomRotation: true,
  renderOrder: 999,
  depthTest:   false,
};

const IMPACT_SEQUENCE: HitSequenceDef = {
  layers: [
    {
      url: '/games/verse_battle/impact/1.png',
      delay: 0,
      duration: 100, // Flash bref
      scale: [1, 20],
      opacity: [1, 0],
      blendMode: THREE.AdditiveBlending,
      rotation: 'random'
    },
    {
      url: '/games/verse_battle/impact/2.png',
      delay: 50,
      duration: 500, // Fade out plus long
      scale: [5, 12],
      opacity: [1, 0],
      blendMode: THREE.NormalBlending,
      rotation: 'random'
    }
  ]
};

// ── PanelManager ──────────────────────────────────────────────────────────────

type PanelSlot = {
  active:boolean; slotIdx:number; z:number; depth:number; meshIdx:number;
  born:number; zoneZ:number; zoneSpeed:number;
  zoneAnim:number; zoneEnterStart:number; zoneExiting:boolean; zoneExitStart:number;
  evaporating:boolean; evaporateStart:number; matched:boolean; colorIdx:number;
  wobble:boolean; wobbleVel:number; offsetX:number; verseUuid:string;
  clearing:boolean; clearStart:number; showLabel:boolean;
};

type VerseBlockSlot = {
  active:boolean; verse:GameVerse|null; z:number;
  slotIdx:number; born:number; meshIdx:number;
  showLabel:boolean; matched:boolean;
  depth:number;
};

interface VerseBlockHandle {
  slots: VerseBlockSlot[];
  spawnWithVerse(verse: GameVerse|null, showLabel: boolean, slotIdx: number, depth: number): void;
  clearAll(): void;
}

interface PanelManagerProps {
  onResult: React.MutableRefObject<(correct: boolean, playerId: string) => void>;
  onImpact: React.MutableRefObject<(x: number, y: number, z: number) => void>;
  onSkip: React.MutableRefObject<() => void>;
  zoneHandle: React.MutableRefObject<ZoneHandle>;
  verseBlockHandle: React.MutableRefObject<VerseBlockHandle>;
  batch: React.MutableRefObject<GameVerse[]>;
  clearHandle: React.MutableRefObject<ClearableHandle>;
  onClearDone: React.MutableRefObject<() => void>;
  spawnEnabled: React.MutableRefObject<boolean>;
  difficulty: React.MutableRefObject<Difficulty>;
  playerPosRef: React.MutableRefObject<Map<string, THREE.Vector3>>;
  spawnQueue: React.MutableRefObject<Array<'zone' | 'block'>>;
  panelOccupied: React.MutableRefObject<Set<number>>;
}

function PanelManager({ onResult, onImpact, onSkip, zoneHandle, verseBlockHandle, batch, clearHandle, onClearDone, spawnEnabled, difficulty, playerPosRef, spawnQueue, panelOccupied }: PanelManagerProps) {
  const isClearingRef = useRef(false);
  const currentVerseRef  = useRef<GameVerse | null>(null);
  const slots       = useRef<PanelSlot[]>([]);
  const lastSpawnMs = useRef(0);
  const groupRefs     = useRef<(THREE.Group | null)[]>(new Array(PANEL_POOL).fill(null));
  const zoneRefs      = useRef<(THREE.Group | null)[]>(new Array(PANEL_POOL).fill(null));
  const faceMeshRefs  = useRef<(THREE.Mesh | null)[]>(new Array(PANEL_POOL).fill(null));
  const labelRefs     = useRef<(THREE.Group | null)[]>(new Array(PANEL_POOL).fill(null));
  const labelDivRefs  = useRef<(HTMLDivElement | null)[]>(new Array(PANEL_POOL).fill(null));
  const labelSpanRefs = useRef<(HTMLSpanElement | null)[]>(new Array(PANEL_POOL).fill(null));

  const [defaultTex, selectedTex] = useTexture([
    '/games/verse_battle/box_verse_default_view.png',
    '/games/verse_battle/box_verse_selected_view.png',
  ]);

  const faceGeo      = useMemo(() => new THREE.BoxGeometry(PANEL_WIDTH, PANEL_H, 1), []);
  const edgesGeo     = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(PANEL_WIDTH, PANEL_H, 1)), []);
  const zoneEdgesGeo = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(PANEL_WIDTH, 1, 1)), []);
  const faceMats     = useMemo(() => Array.from({ length: PANEL_POOL }, () =>
    new THREE.MeshBasicMaterial({
      alphaMap: defaultTex, transparent: true, opacity: 0.55,
      color: new THREE.Color(1, 1, 1), side: THREE.DoubleSide, depthWrite: false,
    })
  ), [defaultTex]); // eslint-disable-line react-hooks/exhaustive-deps
  const mats     = useMemo(() => Array.from({length:PANEL_POOL}, () =>
    new THREE.LineBasicMaterial({color:0xffffff,linewidth:2,transparent:true,opacity:1})), []);
  const zoneMats = useMemo(() => Array.from({length:PANEL_POOL}, () =>
    new THREE.LineBasicMaterial({color:0xffffff,linewidth:2})), []);

  useLayoutEffect(() => {
    const arr: PanelSlot[] = [];
    for (let i = 0; i < PANEL_POOL; i++)
      arr.push({active:false,slotIdx:0,z:SPAWN_Z,depth:PANEL_D_MIN,meshIdx:i,
        born:0,zoneZ:0,zoneSpeed:0,zoneAnim:0,zoneEnterStart:0,
        zoneExiting:false,zoneExitStart:0,evaporating:false,evaporateStart:0,matched:false,colorIdx:0,
        wobble:false,wobbleVel:0,offsetX:0,verseUuid:'',clearing:false,clearStart:0,showLabel:true});
    slots.current = arr;

    zoneHandle.current = {
      tryValidate(playerId, playerX, playerZ) {
        const now = performance.now();
        // Check stationary zone panels
        for (const s of arr) {
          if (!s.active || s.matched || s.evaporating || s.clearing) continue;
          const cx = PANEL_SLOT_X[s.slotIdx] + s.offsetX;
          const hw = PANEL_WIDTH / 2 + P_RADIUS;
          const hd = s.depth / 2 + P_RADIUS;
          if (Math.abs(playerX - cx) > hw || Math.abs(playerZ - s.zoneZ) > hd) continue;
          const cv = currentVerseRef.current;
          const correct = cv !== null && s.verseUuid === cv.uuid;
          onResult.current(correct, playerId);
          if (!correct) {
            const wpos = playerPosRef.current.get(playerId);
            if (wpos) onImpact.current(wpos.x, wpos.y, wpos.z);
          }
          s.matched = true; s.zoneExiting = true; s.zoneExitStart = now;
          s.evaporating = true; s.evaporateStart = now;
          return;
        }
        // Check fast-moving verse blocks
        for (const b of verseBlockHandle.current.slots) {
          if (!b.active || b.matched) continue;
          const bx = PANEL_SLOT_X[b.slotIdx];
          if (Math.abs(playerX - bx) > PANEL_WIDTH / 2 + P_RADIUS) continue;
          const halfD = b.depth / 2;
          // Block overlaps the catchable range: any part within [ZONE_MIN_Z-lead, ZONE_MAX_Z]
          if (b.z + halfD < ZONE_MIN_Z - VBLOCK_VALID_LEAD || b.z - halfD > ZONE_MAX_Z) continue;
          const cv = currentVerseRef.current;
          const correct = cv !== null && b.verse?.uuid === cv.uuid;
          onResult.current(correct, playerId);
          if (!correct) {
            const wpos = playerPosRef.current.get(playerId);
            if (wpos) onImpact.current(wpos.x, wpos.y, wpos.z);
          }
          b.matched = true;
          return;
        }
      },
      getZoneColor(playerX, playerZ) {
        for (const s of arr) {
          if (!s.active || s.matched || s.evaporating || s.clearing) continue;
          const cx = PANEL_SLOT_X[s.slotIdx] + s.offsetX;
          if (Math.abs(playerX - cx) > PANEL_WIDTH / 2 || Math.abs(playerZ - s.zoneZ) > s.depth / 2) continue;
          return mats[s.meshIdx].color;
        }
        return null;
      },
      setCurrentVerse(v) {
        currentVerseRef.current = v;
      },
    };

    clearHandle.current = {
      startClear() {
        verseBlockHandle.current.clearAll();
        const active = arr.filter(s => s.active && !s.clearing && !s.evaporating);
        if (active.length === 0) { onClearDone.current(); return; }
        const now = performance.now();
        active.forEach(s => { s.clearing = true; s.clearStart = now; });
        isClearingRef.current = true;
      },
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((state, delta) => {
    const t   = state.clock.getElapsedTime();
    const now = performance.now();
    const arr = slots.current;

    for (const s of arr) {
      const grp  = groupRefs.current[s.meshIdx];
      const zone = zoneRefs.current[s.meshIdx];
      if (!grp || !zone) continue;

      const label    = labelRefs.current[s.meshIdx];
      const labelDiv = labelDivRefs.current[s.meshIdx];
      if (!s.active) { grp.visible = false; zone.visible = false; if (labelDiv) labelDiv.style.display = 'none'; continue; }

      // Grow-down clearing animation
      if (s.clearing) {
        if (labelDiv) labelDiv.style.display = 'none';
        zone.visible = false;
        const ct = Math.min(1, (now - s.clearStart) / CLEAR_MS);
        if (ct >= 1) {
          s.active = false; grp.visible = false; mats[s.meshIdx].opacity = 1; faceMats[s.meshIdx].opacity = 0.55;
        } else {
          const scY = 1 - ct;
          const cx = PANEL_SLOT_X[s.slotIdx] + s.offsetX;
          const [vwx, vwy] = applyRollYaw(cx, terrainY(cx, s.z, t) + PANEL_H / 2, t, s.z);
          grp.visible = true;
          grp.position.set(vwx, vwy, s.z);
          grp.scale.set(1, scY, s.depth);
          grp.quaternion.copy(surfaceQuat(cx, s.z, t, _squat));
          mats[s.meshIdx].opacity = scY; faceMats[s.meshIdx].opacity = scY;
        }
        continue;
      }

      if (s.evaporating) {
        if (labelDiv) labelDiv.style.display = 'none';
        const et = (now - s.evaporateStart) / EVAPORATE_MS;
        mats[s.meshIdx].opacity = Math.max(0, 1 - et); faceMats[s.meshIdx].opacity = Math.max(0, 1 - et);
        if (et >= 1) { s.active=false; grp.visible=false; zone.visible=false; mats[s.meshIdx].opacity=1; faceMats[s.meshIdx].opacity=1; }
        if (s.zoneExiting && zone.visible) {
          const zt = Math.min(1, (now - s.zoneExitStart) / ZONE_ANIM_MS);
          s.zoneAnim = 1 - zt;
          const cx = PANEL_SLOT_X[s.slotIdx];
          const [wx, wy_z] = applyRollYaw(cx, terrainY(cx, s.zoneZ, t) + 0.05, t, s.zoneZ);
          zone.position.set(wx, wy_z, s.zoneZ);
          zone.quaternion.copy(surfaceQuat(cx, s.zoneZ, t, _squat));
          zone.scale.set(s.zoneAnim, 1, s.depth * s.zoneAnim);
          zone.visible = s.zoneAnim > 0;
        }
        continue;
      }

      s.z += PANEL_SPEED * delta;
      if (s.z > ELIM_BOT_Z) {
        if (!s.matched && s.verseUuid && currentVerseRef.current?.uuid === s.verseUuid)
          onSkip.current();
        s.active=false; grp.visible=false; zone.visible=false; continue;
      }

      const cxBase = PANEL_SLOT_X[s.slotIdx];

      if (s.wobble) {
        s.offsetX += s.wobbleVel * delta;
        const effX = cxBase + s.offsetX;
        const maxX = TERRAIN_W / 2 - PANEL_WIDTH / 2;
        if (effX > maxX || effX < -maxX) {
          s.wobbleVel = -s.wobbleVel;
          s.offsetX   = (effX > 0 ? maxX : -maxX) - cxBase;
        }
      }
      const cx = cxBase + s.offsetX;

      const [vwx, vwy] = applyRollYaw(cx, terrainY(cx, s.z, t) + PANEL_H / 2, t, s.z);
      const va  = Math.min(1, (now - s.born) / ZONE_ANIM_MS);
      grp.visible = true;
      grp.position.set(vwx, vwy, s.z);
      if (label)    label.position.set(vwx, vwy, s.z);
      if (labelDiv) labelDiv.style.display = s.showLabel ? 'block' : 'none';
      grp.scale.set(va, va, s.depth * va);
      grp.quaternion.copy(surfaceQuat(cx, s.z, t, _squat));

      s.zoneZ += s.zoneSpeed * delta;
      s.zoneAnim = s.zoneExiting
        ? Math.max(0, 1 - (now - s.zoneExitStart) / ZONE_ANIM_MS)
        : Math.min(1, (now - s.zoneEnterStart) / ZONE_ANIM_MS);
      const [zwx, zwy] = applyRollYaw(cx, terrainY(cx, s.zoneZ, t) + 0.05, t, s.zoneZ);
      zone.visible = s.zoneAnim > 0;
      zone.position.set(zwx, zwy, s.zoneZ);
      zone.scale.set(s.zoneAnim, 1, s.depth * s.zoneAnim);
      zone.quaternion.copy(surfaceQuat(cx, s.zoneZ, t, _squat));

      // Face texture: switch to selected when any player is inside the zone
      {
        const faceMat = faceMats[s.meshIdx];
        let anyInZone = false;
        for (const [, wpos] of playerPosRef.current) {
          if (Math.abs(wpos.x - cx) < PANEL_WIDTH / 2 && Math.abs(wpos.z - s.zoneZ) < s.depth / 2) {
            anyInZone = true; break;
          }
        }
        const want = anyInZone ? selectedTex : defaultTex;
        if (faceMat.alphaMap !== want) { faceMat.alphaMap = want; faceMat.needsUpdate = true; }
      }

      // Panel caught up to its zone — zone disappears, panel evaporates (no auto-score)
      if (!s.matched && s.z >= s.zoneZ) {
        s.matched = true; s.zoneExiting = true; s.zoneExitStart = now;
        s.evaporating = true; s.evaporateStart = now;
      }
    }

    if (isClearingRef.current && !arr.some(s => s.active)) {
      isClearingRef.current = false;
      onClearDone.current();
    }

    const activePanels = arr.filter(s => s.active && !s.evaporating && !s.clearing).length;
    const activeBlocks = verseBlockHandle.current.slots.filter(b => b.active).length;
    if (spawnEnabled.current && activePanels + activeBlocks < difficulty.current.maxPanels &&
        now - lastSpawnMs.current >= 1000 / PANEL_HZ) {

      // Pick slot (for X position, shared by all rep types)
      const usedSlots = new Set(arr.filter(s => s.active && !s.wobble).map(s => s.slotIdx));
      panelOccupied.current = usedSlots;
      const freeSlots = PANEL_SLOT_X.map((_, i) => i).filter(i => !usedSlots.has(i));
      const wobble    = freeSlots.length === 0;
      const slotIdx   = wobble
        ? Math.floor(Math.random() * PANEL_SLOT_X.length)
        : freeSlots[Math.floor(Math.random() * freeSlots.length)];
      const wobbleVel = wobble ? rnd(PANEL_SPEED * 7, PANEL_SPEED * 10) * (Math.random() < 0.5 ? 1 : -1) : 0;

      const b = batch.current;
      // Count active instances per UUID (panels + blocks) — cap at 2 per verse
      const _cnt = new Map<string, number>();
      for (const s of arr) if (s.active && !s.evaporating && !s.clearing && s.verseUuid)
        _cnt.set(s.verseUuid, (_cnt.get(s.verseUuid) ?? 0) + 1);
      for (const bl of verseBlockHandle.current.slots) if (bl.active && bl.verse?.uuid)
        _cnt.set(bl.verse.uuid, (_cnt.get(bl.verse.uuid) ?? 0) + 1);
      const availV = b.filter(v => (_cnt.get(v.uuid) ?? 0) < 2);
      if (availV.length === 0) { lastSpawnMs.current = now; } else {

      const verseForSlot = availV[Math.floor(Math.random() * availV.length)];

      // Per-round queue guarantees zone/block ratio; 'both' is a rare depth-scaled upgrade on blocks
      if (spawnQueue.current.length === 0)
        spawnQueue.current = makeSpawnQueue(Math.ceil(ROUND_PLAY_S * PANEL_HZ * 2));
      const queued = spawnQueue.current.shift()!;

      const blockDepth = VBLOCK_D_MIN + Math.random() * (VBLOCK_D_MAX - VBLOCK_D_MIN);
      const depthFrac  = (blockDepth - VBLOCK_D_MIN) / (VBLOCK_D_MAX - VBLOCK_D_MIN);
      const bothProb   = VBLOCK_BOTH_PROB * (1 - depthFrac);
      const repType: 'zone' | 'block' | 'both' =
        queued === 'block' && Math.random() < bothProb ? 'both' : queued;

      if (repType === 'block') {
        verseBlockHandle.current.spawnWithVerse(verseForSlot, true, slotIdx, blockDepth);
        lastSpawnMs.current = now;
      } else {
        const slot = arr.find(s => !s.active);
        if (slot) {
          if (repType === 'both') verseBlockHandle.current.spawnWithVerse(verseForSlot, true, slotIdx, blockDepth);

          const nominalDepth = PANEL_D_MIN + Math.random() * (PANEL_D_MAX - PANEL_D_MIN);
          const minDepth     = nominalDepth / 4.5;

          // Compute free Z ranges only among panels in the same slot.
          const occupiedIntervals = arr
            .filter(s => s.active && !s.evaporating && !s.clearing && s.slotIdx === slotIdx)
            .map(s => [s.zoneZ - s.depth / 2 - s.depth * 0.05, s.zoneZ + s.depth / 2 + s.depth * 0.05] as [number,number])
            .sort((a, b) => a[0] - b[0]);
          const freeRanges: [number, number][] = [];
          let cur = ZONE_MIN_Z;
          for (const [iLo, iHi] of occupiedIntervals) {
            if (iLo > cur) freeRanges.push([cur, iLo]);
            cur = Math.max(cur, iHi);
          }
          if (cur < ZONE_MAX_Z) freeRanges.push([cur, ZONE_MAX_Z]);

          let depth = nominalDepth;
          let zoneZ = (ZONE_MIN_Z + ZONE_MAX_Z) / 2;
          if (occupiedIntervals.length > 0) {
            const validRanges = freeRanges.filter(([a, bv]) => bv - a >= minDepth);
            if (validRanges.length > 0) {
              const [ra, rb] = validRanges[Math.floor(Math.random() * validRanges.length)];
              depth = Math.min(rb - ra, nominalDepth);
              const halfD = depth / 2;
              zoneZ = (ra + halfD) + Math.random() * Math.max(0, (rb - halfD) - (ra + halfD));
            }
          }

          const maxV     = (ZONE_MAX_Z - zoneZ) * PANEL_SPEED / (zoneZ - SPAWN_Z);
          const zoneSpeed = maxV * rnd(0.25, 0.28);
          const showLabel = repType === 'zone'; // 'both' → label is on block

          Object.assign(slot, {
            active:true, slotIdx,
            z:SPAWN_Z, depth, born:now, zoneZ, zoneSpeed,
            zoneAnim:0, zoneEnterStart:now, zoneExiting:false, zoneExitStart:0,
            evaporating:false, matched:false, offsetX:0, wobble, wobbleVel,
            verseUuid: verseForSlot?.uuid ?? '', clearing:false, clearStart:0, showLabel,
          });
          mats[slot.meshIdx].opacity = 1;
          const colorIdx = Math.floor(Math.random() * PANEL_COLORS.length);
          slot.colorIdx = colorIdx;
          mats[slot.meshIdx].color.copy(PANEL_COLORS[colorIdx]);
          zoneMats[slot.meshIdx].color.copy(PANEL_COLORS[colorIdx]);
          faceMats[slot.meshIdx].color.copy(PANEL_COLORS[colorIdx]);
          faceMats[slot.meshIdx].opacity = 0.55;
          faceMats[slot.meshIdx].alphaMap = defaultTex;
          faceMats[slot.meshIdx].needsUpdate = true;
          if (showLabel) {
            const span = labelSpanRefs.current[slot.meshIdx];
            if (span && verseForSlot) {
              const css = PANEL_CSS_COLORS[colorIdx];
              span.style.textShadow = `0 0 8px ${css},0 0 22px ${css}`;
              span.textContent = `${verseForSlot.bookName} ${verseForSlot.chapterNumber}:${verseForSlot.verseNumber}`;
            }
          }
          lastSpawnMs.current = now;
        }
      }
      } // end availV guard
    }
  });

  return (
    <>
      {mats.map((mat, i) => (
        <group key={i} ref={el => { groupRefs.current[i] = el; }} visible={false}>
          <lineSegments geometry={edgesGeo} material={mat} />
          <mesh ref={el => { faceMeshRefs.current[i] = el; }} geometry={faceGeo} material={faceMats[i]} />
        </group>
      ))}
      {zoneMats.map((mat, i) => (
        <group key={`z${i}`} ref={el => { zoneRefs.current[i] = el; }} visible={false}>
          <lineSegments geometry={zoneEdgesGeo} material={mat} />
        </group>
      ))}
      {Array.from({length: PANEL_POOL}, (_, i) => (
        <group key={`lbl${i}`} ref={el => { labelRefs.current[i] = el; }}>
          <Html center style={{pointerEvents:'none'}} zIndexRange={[1,0]}>
            <div ref={el => { labelDivRefs.current[i] = el; }} style={{display:'none'}}>
              <span ref={el => { labelSpanRefs.current[i] = el; }}
                style={{color:'#fff',fontFamily:'monospace',fontSize:15,fontWeight:700,
                textShadow:'0 0 6px #fff',whiteSpace:'nowrap',userSelect:'none'}} />
            </div>
          </Html>
        </group>
      ))}
    </>
  );
}

// ── VerseBlock shaders ────────────────────────────────────────────────────────
// Block deformation mirrors terrainY + rollAngle exactly (same math as terrain GLSL).
// position.z is in [-0.5, 0.5] (unit-depth geometry); uDepth scales it to world depth.
// We bypass modelMatrix entirely: gl_Position = projectionMatrix * viewMatrix * worldPos.

const VBLOCK_VERT = /* glsl */`
uniform float uTime;
uniform float uSlotX;
uniform float uCenterZ;
uniform float uDepth;
uniform float uRollAmpScale;
uniform float uRollGateProb;
uniform float uRollFreqScale;
uniform float uYawAmpScale;
uniform float uYawFreqScale;
uniform float uYawGateProb;

float terrainYFn(float lx, float z) {
  float ramp = min(1.0, uTime / 90.0);
  float c1 = max(0.0, sin(z * 0.031 - uTime * 3.1));
  float c2 = max(0.0, sin(z * 0.019 - uTime * 1.9 + 2.3));
  float c3 = max(0.0, sin(z * 0.051 - uTime * 5.1 + 0.7));
  float env = c1*c1*0.7 + c2*c2*0.9 + c3*c3*0.4;
  float base = 0.4*sin(z*0.05-uTime*5.0) + 0.2*sin(z*0.031+lx*0.02-uTime*3.1);
  float bumps = base + ramp*env*(
    3.2 *sin(z*0.137  - uTime*13.7) +
    2.1 *sin(z*0.0893 + lx*0.04  - uTime*8.93  + 1.57) +
    1.4 *sin(z*0.211  - lx*0.061 - uTime*21.1  + 0.83) +
    0.9 *sin(z*0.073  + lx*0.029 - uTime*7.3   + 3.14) +
    0.5 *sin(z*0.317  - lx*0.08  - uTime*31.7  + 2.0)
  );
  return bumps + sqrt(max(0.0, ${CYL_R * CYL_R}.0 - lx*lx)) - ${CYL_R}.0;
}

float rollAngleFn(float z) {
  float kz    = 0.008 * uRollFreqScale;
  float u     = z * kz - uTime * (kz * 100.0);
  float gateU = u * 0.38;
  float gateV = sin(gateU)*0.6 + sin(gateU*0.66+1.7)*0.4;
  float thr   = 1.0 - 2.0 * uRollGateProb;
  float gate  = clamp((gateV-(thr-0.35))/0.35, 0.0, 1.0);
  float noise = (0.55*sin(u)+0.35*sin(u*1.6+1.13)+0.22*sin(u*2.5+2.71)+0.14*sin(u*3.8+0.42))/1.26;
  return clamp(uRollAmpScale*gate*3.14159265*0.45*noise, -0.7854, 0.7854);
}

float roadXOffsetFn(float z) {
  float kz = 0.005 * uYawFreqScale;
  float u  = z * kz - uTime * (kz * 100.0);
  float gateU = u * 0.42;
  float gateV = sin(gateU)*0.6 + sin(gateU*0.68+1.9)*0.4;
  float thr   = 1.0 - 2.0 * uYawGateProb;
  float gate  = clamp((gateV-(thr-0.35))/0.35, 0.0, 1.0);
  float noise = (0.50*sin(u+0.3) + 0.35*sin(u*1.65+1.2) + 0.20*sin(u*2.7+2.5)) / 1.05;
  return uYawAmpScale * gate * 28.0 * noise;
}

void main() {
  float worldZ = uCenterZ + position.z * uDepth;
  float lX     = uSlotX + position.x;
  float ty     = terrainYFn(lX, worldZ);
  float lY     = ty + (position.y + ${VBLOCK_H * 0.5});
  float phi    = rollAngleFn(worldZ);
  float cosP   = cos(phi), sinP = sin(phi);
  float rendX  = lX*cosP - lY*sinP + roadXOffsetFn(worldZ);
  gl_Position  = projectionMatrix * viewMatrix * vec4(rendX, lX*sinP + lY*cosP, worldZ, 1.0);
}
`;

const VBLOCK_FILL_FRAG = /* glsl */`
uniform vec3 uColor;
void main() { gl_FragColor = vec4(uColor, 0.18); }
`;

const VBLOCK_LINE_FRAG = /* glsl */`
uniform vec3 uColor;
void main() { gl_FragColor = vec4(uColor, 1.0); }
`;

// Outline: front/back cap rectangles + 4 corner lines with N Z-subdivisions for smooth curving.
function createBlockOutlineGeo(W: number, H: number, N: number): THREE.BufferGeometry {
  const hw = W / 2, hh = H / 2;
  const corners: [number, number][] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  const pos: number[] = [];
  // Front cap (z=-0.5) and back cap (z=+0.5)
  for (const z of [-0.5, 0.5])
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = corners[i], [bx, by] = corners[(i + 1) % 4];
      pos.push(ax, ay, z, bx, by, z);
    }
  // 4 corner spine lines along Z with N segments each
  for (const [cx, cy] of corners)
    for (let k = 0; k < N; k++) {
      const z0 = -0.5 + k / N, z1 = -0.5 + (k + 1) / N;
      pos.push(cx, cy, z0, cx, cy, z1);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}

// ── VerseBlockManager ─────────────────────────────────────────────────────────
// Single mesh per block with shader-based terrain deformation (no CPU segments).
// Outline uses a custom geometry with only outer edges (no internal segment edges).

function VerseBlockManager({ verseBlockHandle }: {
  verseBlockHandle: React.MutableRefObject<VerseBlockHandle>;
}) {
  const slots        = useRef<VerseBlockSlot[]>([]);
  const meshRefs     = useRef<(THREE.Mesh    | null)[]>(new Array(VBLOCK_POOL).fill(null));
  const outlineRefs  = useRef<(THREE.LineSegments | null)[]>(new Array(VBLOCK_POOL).fill(null));
  const labelRefs    = useRef<(THREE.Group   | null)[]>(new Array(VBLOCK_POOL).fill(null));
  const labelDivRefs  = useRef<(HTMLDivElement | null)[]>(new Array(VBLOCK_POOL).fill(null));
  const labelSpanRefs = useRef<(HTMLSpanElement | null)[]>(new Array(VBLOCK_POOL).fill(null));

  // Shared geometries — depth handled via uniform (uDepth), not scale
  const blockGeo   = useMemo(() => new THREE.BoxGeometry(PANEL_WIDTH, VBLOCK_H, 1, 1, 1, VBLOCK_SEGS), []);
  const outlineGeo = useMemo(() => createBlockOutlineGeo(PANEL_WIDTH, VBLOCK_H, 16), []);

  // Per-slot shader materials (each slot has different uniforms: slotX, centerZ, depth, color)
  function makeBlockUniforms() {
    return {
      uTime:          { value: 0 },
      uSlotX:         { value: 0 },
      uCenterZ:       { value: 0 },
      uDepth:         { value: VBLOCK_D },
      uRollAmpScale:  { value: 1 },
      uRollGateProb:  { value: 0.01 },
      uRollFreqScale: { value: 1 },
      uYawAmpScale:   { value: 0 },
      uYawFreqScale:  { value: 1 },
      uYawGateProb:   { value: 0.01 },
      uColor:         { value: new THREE.Color(1, 1, 1) },
    };
  }
  const fillMats    = useMemo(() => Array.from({ length: VBLOCK_POOL }, () =>
    new THREE.ShaderMaterial({ vertexShader: VBLOCK_VERT, fragmentShader: VBLOCK_FILL_FRAG,
      uniforms: makeBlockUniforms(), transparent: true, depthWrite: false, side: THREE.DoubleSide })
  ), []); // eslint-disable-line react-hooks/exhaustive-deps
  const outlineMats = useMemo(() => Array.from({ length: VBLOCK_POOL }, () =>
    new THREE.ShaderMaterial({ vertexShader: VBLOCK_VERT, fragmentShader: VBLOCK_LINE_FRAG,
      uniforms: makeBlockUniforms(), transparent: true, depthWrite: false })
  ), []); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const arr: VerseBlockSlot[] = [];
    for (let i = 0; i < VBLOCK_POOL; i++)
      arr.push({ active:false, verse:null, z:SPAWN_Z, slotIdx:0, born:0, meshIdx:i,
                 showLabel:false, matched:false, depth:VBLOCK_D });
    slots.current = arr;

    verseBlockHandle.current = {
      slots: arr,
      spawnWithVerse(verse, showLabel, slotIdx, depth) {
        const s = arr.find(s => !s.active);
        if (!s) return;
        const colorIdx = Math.floor(Math.random() * PANEL_COLORS.length);
        Object.assign(s, { active:true, verse, z:SPAWN_Z, slotIdx, born:performance.now(),
                           showLabel, matched:false, depth });
        fillMats[s.meshIdx].uniforms.uColor.value.copy(PANEL_COLORS[colorIdx]);
        outlineMats[s.meshIdx].uniforms.uColor.value.copy(PANEL_COLORS[colorIdx]);
        const span = labelSpanRefs.current[s.meshIdx];
        if (span && verse && showLabel) {
          const css = PANEL_CSS_COLORS[colorIdx];
          span.style.textShadow = `0 0 8px ${css},0 0 22px ${css}`;
          span.textContent = `${verse.bookName} ${verse.chapterNumber}:${verse.verseNumber}`;
        }
      },
      clearAll() { for (const s of arr) s.active = false; },
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((state, delta) => {
    const t = state.clock.getElapsedTime();

    for (const s of slots.current) {
      const mesh    = meshRefs.current[s.meshIdx];
      const outline = outlineRefs.current[s.meshIdx];
      const lbl     = labelRefs.current[s.meshIdx];
      const lblDiv  = labelDivRefs.current[s.meshIdx];

      if (!s.active) {
        if (mesh)    mesh.visible    = false;
        if (outline) outline.visible = false;
        if (lblDiv)  lblDiv.style.display = 'none';
        continue;
      }

      s.z += VBLOCK_SPEED * delta;
      if (s.z - s.depth / 2 > ELIM_BOT_Z) {
        s.active = false;
        if (mesh)    mesh.visible    = false;
        if (outline) outline.visible = false;
        if (lblDiv)  lblDiv.style.display = 'none';
        continue;
      }

      // Push uniforms to both materials
      const slotX = PANEL_SLOT_X[s.slotIdx];
      for (const mat of [fillMats[s.meshIdx], outlineMats[s.meshIdx]]) {
        const u = mat.uniforms;
        u.uTime.value          = t;
        u.uSlotX.value         = slotX;
        u.uCenterZ.value       = s.z;
        u.uDepth.value         = s.depth;
        u.uRollAmpScale.value  = _rollParams.ampScale;
        u.uRollGateProb.value  = _rollParams.gateProb;
        u.uRollFreqScale.value = _rollParams.freqScale;
        u.uYawAmpScale.value   = _yawParams.ampScale;
        u.uYawFreqScale.value  = _yawParams.freqScale;
        u.uYawGateProb.value   = _yawParams.gateProb;
      }

      if (mesh)    mesh.visible    = true;
      if (outline) outline.visible = true;

      // Label at block center (CPU applyRoll for HTML position)
      const [lwx, lwy] = applyRollYaw(slotX, terrainY(slotX, s.z, t) + VBLOCK_H / 2 + 2, t, s.z);
      if (lbl) lbl.position.set(lwx, lwy, s.z);
      if (lblDiv) lblDiv.style.display = s.showLabel && !s.matched ? 'block' : 'none';
    }
  });

  return (
    <>
      {Array.from({ length: VBLOCK_POOL }, (_, i) => (
        <group key={`vbg${i}`}>
          <mesh ref={el => { meshRefs.current[i] = el; }}
            geometry={blockGeo} material={fillMats[i]}
            visible={false} frustumCulled={false} />
          <lineSegments ref={el => { outlineRefs.current[i] = el as THREE.LineSegments; }}
            geometry={outlineGeo} material={outlineMats[i]}
            visible={false} frustumCulled={false} />
        </group>
      ))}
      {Array.from({ length: VBLOCK_POOL }, (_, i) => (
        <group key={`vbl${i}`} ref={el => { labelRefs.current[i] = el; }}>
          <Html center style={{ pointerEvents: 'none' }} zIndexRange={[1, 0]}>
            <div ref={el => { labelDivRefs.current[i] = el; }} style={{ display: 'none' }}>
              <span ref={el => { labelSpanRefs.current[i] = el; }}
                style={{ color:'#fff', fontFamily:'monospace', fontSize:15, fontWeight:700,
                  textShadow:'0 0 6px #fff', whiteSpace:'nowrap', userSelect:'none' }} />
            </div>
          </Html>
        </group>
      ))}
    </>
  );
}

// ── PlayerSphere ──────────────────────────────────────────────────────────────

function PlayerSphere(props: Omit<PlayerBodyProps, 'initPos'>) {
  const initPos = useMemo<[number, number, number]>(() => [
    randLane() + rnd(-1, 1), P_RADIUS + 2, rnd(ZONE_MIN_Z + 2, ZONE_MAX_Z - 2),
  ], []);
  return <PlayerSphereBody {...props} initPos={initPos} />;
}

// ── Score HUD ─────────────────────────────────────────────────────────────────

function ScoreHUD({ controllers, scores }: { controllers: ControllerDisplay[]; scores: Record<string,number> }) {
  return (
    <div style={{position:'absolute',top:12,left:'50%',transform:'translateX(-50%)',
      display:'flex',gap:24,pointerEvents:'none',zIndex:10}}>
      {controllers.map(ctrl => (
        <div key={ctrl.id} style={{background:'rgba(0,0,0,0.55)',border:'1px solid rgba(255,255,255,0.18)',
          borderRadius:8,padding:'4px 14px',color:'#fff',fontFamily:'monospace',fontWeight:700,textAlign:'center',minWidth:70}}>
          <div style={{fontSize:11,opacity:0.7,marginBottom:2}}>{ctrl.pseudo||ctrl.id.slice(0,6)}</div>
          <div style={{fontSize:28,lineHeight:1}}>{scores[ctrl.id]??0}</div>
        </div>
      ))}
    </div>
  );
}


// ── RoundIntroOverlay ─────────────────────────────────────────────────────────

// slide: 'in' = entering from right, 'out' = exiting to left
function useSlideAnim(key: unknown, totalMs: number, outMs: number) {
  const [tx, setTx] = useState('100%');
  useLayoutEffect(() => {
    setTx('100%');
    const t1 = setTimeout(() => setTx('0%'), 50);
    const t2 = setTimeout(() => setTx('-100%'), totalMs - outMs);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return tx;
}

function RoundIntroOverlay({ round, verse, onDone }: { round: number; verse: GameVerse | null; onDone: () => void }) {
  const [countdown, setCountdown] = useState(ROUND_INTRO_S);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const tx = useSlideAnim(round, ROUND_INTRO_S * 1000, 550);

  useLayoutEffect(() => {
    setCountdown(ROUND_INTRO_S);
    const t3 = setTimeout(() => doneRef.current(), ROUND_INTRO_S * 1000);
    const id = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { clearInterval(id); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => { clearTimeout(t3); clearInterval(id); };
  }, [round]);

  return (
    <div style={{position:'absolute',inset:0,zIndex:50,display:'flex',flexDirection:'column',
      alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.88)',backdropFilter:'blur(6px)',
      pointerEvents:'none',
      transform: `translateX(${tx})`,
      transition: 'transform 0.5s ease-out'}}>
      <div style={{fontFamily:'monospace',color:'#888',fontSize:12,letterSpacing:4,
        textTransform:'uppercase',marginBottom:20}}>
        Tour {round}
      </div>
      {verse && (
        <div style={{maxWidth:'60%',textAlign:'center',marginBottom:36}}>
          <div style={{color:'#fff',fontFamily:'Georgia,serif',fontStyle:'italic',
            fontSize:28,lineHeight:1.65}}>
            {verse.content}
          </div>
        </div>
      )}
      <div style={{color:'#D4AC0D',fontFamily:'monospace',fontSize:60,fontWeight:700,lineHeight:1}}>
        {countdown}
      </div>
    </div>
  );
}

// ── AnswerRevealOverlay ──────────────────────────────────────────────────────

function AnswerRevealOverlay({ verse, winnerName, onDone }: {
  verse: GameVerse | null;
  winnerName: string | null;
  onDone: () => void;
}) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const tx = useSlideAnim(verse, 9000, 500);

  useLayoutEffect(() => {
    const t3 = setTimeout(() => doneRef.current(), 9000);
    return () => clearTimeout(t3);
  }, [verse]);

  return (
    <div style={{position:'absolute',inset:0,zIndex:50,display:'flex',flexDirection:'column',
      alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.88)',backdropFilter:'blur(6px)',
      pointerEvents:'none',
      transform: `translateX(${tx})`,
      transition: 'transform 0.5s ease-out'}}>
      <div style={{fontFamily:'monospace',color:'#888',fontSize:12,letterSpacing:4,
        textTransform:'uppercase',marginBottom:20}}>
        Bonne réponse
      </div>
      {verse && (
        <div style={{maxWidth:'62%',textAlign:'center',marginBottom:28}}>
          <div style={{color:'#D4AC0D',fontFamily:'monospace',fontSize:14,fontWeight:700,marginBottom:14,letterSpacing:1}}>
            {verse.bookName} {verse.chapterNumber}:{verse.verseNumber}
          </div>
          <div style={{color:'#fff',fontFamily:'Georgia,serif',fontStyle:'italic',
            fontSize:24,lineHeight:1.7}}>
            {verse.content}
          </div>
        </div>
      )}
      {winnerName !== null ? (
        <div style={{color:'#1abc9c',fontFamily:'monospace',fontSize:18,fontWeight:700,letterSpacing:1}}>
          ✓ {winnerName}
        </div>
      ) : (
        <div style={{color:'#e74c3c',fontFamily:'monospace',fontSize:13,opacity:0.7}}>
          Personne n'a trouvé
        </div>
      )}
    </div>
  );
}

// ── RoundTimerHUD ──────────────────────────────────────────────────────────────

function RoundTimerHUD({ seconds, round }: { seconds: number; round: number }) {
  const urgent = seconds <= 10;
  return (
    <div style={{position:'absolute',top:12,right:16,pointerEvents:'none',zIndex:10,textAlign:'right'}}>
      <div style={{fontFamily:'monospace',fontSize:10,color:'#666',marginBottom:2,letterSpacing:2}}>
        TOUR {round}
      </div>
      <div style={{fontFamily:'monospace',fontSize:32,fontWeight:700,lineHeight:1,
        color: urgent ? '#e74c3c' : '#fff',
        textShadow: urgent ? '0 0 14px #e74c3c88' : 'none'}}>
        {seconds}
      </div>
    </div>
  );
}

// ── Scene ─────────────────────────────────────────────────────────────────────

function VerseBattleScene({ controllers, inputsMap, colorMap, onResult, onSkip, zoneHandle, batch,
  enemyClear, boxClear, panelClear, onClearDone, spawnEnabled, difficulty, spawnQueue, roomId }: {
  controllers: ControllerDisplay[];
  inputsMap: React.MutableRefObject<Map<string, ControllerState>>;
  colorMap: React.MutableRefObject<Record<string, string>>;
  onResult: React.MutableRefObject<(correct: boolean, playerId: string) => void>;
  onSkip: React.MutableRefObject<() => void>;
  zoneHandle: React.MutableRefObject<ZoneHandle>;
  batch: React.MutableRefObject<GameVerse[]>;
  enemyClear: React.MutableRefObject<ClearableHandle>;
  boxClear: React.MutableRefObject<ClearableHandle>;
  panelClear: React.MutableRefObject<ClearableHandle>;
  onClearDone: React.MutableRefObject<() => void>;
  spawnEnabled: React.MutableRefObject<boolean>;
  difficulty: React.MutableRefObject<Difficulty>;
  spawnQueue: React.MutableRefObject<Array<'zone' | 'block'>>;
  roomId: string;
}) {
  const enemyHandle      = useRef<EnemyHandle>({ slots:[], pushSlot:()=>{} });
  const spawnBeamRef     = useRef<SpawnBeam>(() => {});
  const playerPosRef     = useRef<Map<string, THREE.Vector3>>(new Map());
  const playerMoveDirRef = useRef<[number, number]>([0, -1]);
  const boxHitRef        = useRef<Map<string, number>>(new Map());
  const verseBlockHandle = useRef<VerseBlockHandle>({ slots:[], spawnWithVerse:()=>{}, clearAll:()=>{} }); // eslint-disable-line @typescript-eslint/no-empty-function
  const panelOccupiedRef = useRef<Set<number>>(new Set());
  const onImpactRef      = useRef((x: number, y: number, z: number) => {
    SpriteAnimService.play(WRONG_ANSWER_ANIM, x, y, z);
    HitAnimService.play(IMPACT_SEQUENCE, x, y, z);
  });

  const handleBoxHit = useCallback((id: string, nx: number) => {
    boxHitRef.current.set(id, (boxHitRef.current.get(id) ?? 0) + nx);
  }, []);

  return (
    <>
      <color attach="background" args={['#02A9EA']} />
      <ambientLight intensity={0.35} />
      <directionalLight position={[20,60,40]} intensity={1.6} castShadow
        shadow-mapSize-width={2048} shadow-mapSize-height={2048}
        shadow-camera-left={-60} shadow-camera-right={60}
        shadow-camera-top={100} shadow-camera-bottom={-30}
        shadow-camera-near={1} shadow-camera-far={300} shadow-bias={-0.001} />
      <fog attach="fog" args={['#02A9EA', 180, 700]} />

      <CameraRig />
      <ParticleField />
      <CylinderVolume />
      <CanopyField />
      <LeafParticleField />
      <DynamicTerrain />
      <MapBranchManager handle={enemyHandle} clearHandle={enemyClear}
        onClearDone={onClearDone} spawnEnabled={spawnEnabled} difficulty={difficulty} panelOccupied={panelOccupiedRef} playerMoveDirRef={playerMoveDirRef} />
      <BeamManager spawnRef={spawnBeamRef} />
      <BoxObstacleManager playerPosRef={playerPosRef} onHit={handleBoxHit}
        clearHandle={boxClear} onClearDone={onClearDone} spawnEnabled={spawnEnabled} difficulty={difficulty} />

      {controllers.map(ctrl => (
        <PlayerSphere key={ctrl.id} controller={ctrl} inputsMap={inputsMap}
          enemyHandle={enemyHandle} spawnBeam={spawnBeamRef} playerPosRef={playerPosRef}
          boxHitRef={boxHitRef} zoneHandle={zoneHandle} playerMoveDirRef={playerMoveDirRef} roomId={roomId}
          color={colorMap.current[ctrl.id] ?? '#ffffff'} />
      ))}

      <VerseBlockManager verseBlockHandle={verseBlockHandle} />
      <PanelManager onResult={onResult} onImpact={onImpactRef} onSkip={onSkip} zoneHandle={zoneHandle}
        verseBlockHandle={verseBlockHandle} batch={batch}
        clearHandle={panelClear} onClearDone={onClearDone} spawnEnabled={spawnEnabled} difficulty={difficulty}
        playerPosRef={playerPosRef} spawnQueue={spawnQueue} panelOccupied={panelOccupiedRef} />
      <SpriteAnimLayer />
      <HitAnimLayer />

      <EffectComposer>
        <EdgeOutlineEffect />
        <FoliageBlobEffect />
        <Bloom luminanceThreshold={0.8} luminanceSmoothing={0.3} intensity={4.0} />
      </EffectComposer>
    </>
  );
}

// Generates a shuffled queue of spawn types so each round independently follows the
// configured zone/block ratio (not accumulated over the whole game).
function makeSpawnQueue(n: number): Array<'zone' | 'block'> {
  const nZone = Math.round(n * ZONE_PROB);
  const arr: Array<'zone' | 'block'> = [
    ...Array<'zone'>(nZone).fill('zone'),
    ...Array<'block'>(n - nZone).fill('block'),
  ];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── VerseBattleGame ───────────────────────────────────────────────────────────

export interface GameVerse {
  uuid: string;
  bookName: string;
  chapterNumber: number;
  verseNumber: number;
  content: string;
}

export interface VerseBattleGameProps {
  controllers: ControllerDisplay[];
  gameOnInputRef: React.MutableRefObject<(frame: ControllerFrame) => void>;
  verses: GameVerse[];
  roomId: string;
  config: GameConfig;
}

export default function VerseBattleGame({ controllers, gameOnInputRef, verses, roomId, config }: VerseBattleGameProps) {
  const inputsMap = useRef<Map<string, ControllerState>>(new Map());
  const [scores, setScores]                         = useState<Record<string, number>>({});
  const [currentVerseIdx, setCurrentVerseIdx]       = useState(0);
  const [roundNumber, setRoundNumber]               = useState(1);
  const [roundPhase, setRoundPhase]                 = useState<'clearing'|'intro'|'playing'|'answer'>('intro');
  const [roundTimer, setRoundTimer]                 = useState(ROUND_PLAY_S);
  const [lastCorrectPlayerId, setLastCorrectPlayerId] = useState<string | null>(null);
  const [lastRoundVerse, setLastRoundVerse]         = useState<GameVerse | null>(null);
  const [eliminated, setEliminated]                 = useState<Set<string>>(new Set());
  const [gameOver, setGameOver]                     = useState(false);

  const batchLockedRef  = useRef(false);
  const currentVerse    = verses.length > 0 ? verses[currentVerseIdx % verses.length] : null;

  const clearedCount    = useRef(0);
  const onClearDoneRef  = useRef<() => void>(() => {});
  const enemyClearRef   = useRef<ClearableHandle>({ startClear: () => {} });
  const boxClearRef     = useRef<ClearableHandle>({ startClear: () => {} });
  const panelClearRef   = useRef<ClearableHandle>({ startClear: () => {} });
  const spawnEnabledRef = useRef(false);
  const difficultyRef   = useRef<Difficulty>(getDifficulty(1));
  const batchRef        = useRef<GameVerse[]>([]);
  const spawnQueueRef   = useRef<Array<'zone' | 'block'>>([]);
  const endRoundRef     = useRef<(winnerId: string | null) => void>(() => {});

  const zoneHandle  = useRef<ZoneHandle>({ tryValidate:()=>{}, getZoneColor:()=>null, setCurrentVerse:()=>{} });
  const onResultRef = useRef<(correct: boolean, playerId: string) => void>(() => {});
  const onSkipRef   = useRef<() => void>(() => {});

  // Update difficulty params when round changes
  useLayoutEffect(() => {
    const d = getDifficulty(getEffectiveRound(roundNumber, config.difficulty));
    difficultyRef.current  = d;
    _rollParams.ampScale   = d.rollAmpScale;
    _rollParams.freqScale  = d.rollFreqScale;
    _rollParams.gateProb   = d.rollGateProb;
    _pitchParams.ampScale  = d.pitchAmpScale;
    _pitchParams.freqScale = d.pitchFreqScale;
    _yawParams.ampScale    = d.yawAmpScale;
    _yawParams.freqScale   = d.yawFreqScale;
    _yawParams.gateProb    = d.yawGateProb;
  }, [roundNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  // Round phase state machine
  useLayoutEffect(() => {
    if (roundPhase === 'clearing') {
      spawnEnabledRef.current = false;
      clearedCount.current = 0;
      onClearDoneRef.current = () => {
        clearedCount.current++;
        if (clearedCount.current >= 3) setRoundPhase('intro');
      };
      enemyClearRef.current.startClear();
      boxClearRef.current.startClear();
      panelClearRef.current.startClear();
    } else if (roundPhase === 'intro') {
      spawnEnabledRef.current = false;
      const cv = currentVerse;
      if (cv && verses.length > 0) {
        if (!batchLockedRef.current) {
          const d = difficultyRef.current;
          const falsePool = verses.filter(v => v.uuid !== cv.uuid);
          const falseCount = Math.max(0, d.maxPanels - 1);
          const batch: GameVerse[] = [cv];
          for (let i = 0; i < falseCount && falsePool.length > 0; i++)
            batch.push(falsePool[Math.floor(Math.random() * falsePool.length)]);
          batchRef.current = batch;
          if (config.batchStyle === 'whole-game') batchLockedRef.current = true;
        } else {
          // Whole-game: ensure cv is in the locked batch
          if (!batchRef.current.find(v => v.uuid === cv.uuid)) {
            const swapIdx = Math.floor(Math.random() * batchRef.current.length);
            batchRef.current = [...batchRef.current];
            batchRef.current[swapIdx] = cv;
          }
        }
        zoneHandle.current.setCurrentVerse(cv);
      }
    } else if (roundPhase === 'playing') {
      spawnEnabledRef.current = true;
      spawnQueueRef.current = makeSpawnQueue(Math.ceil(ROUND_PLAY_S * PANEL_HZ * 2));
    } else if (roundPhase === 'answer') {
      spawnEnabledRef.current = false;
    }
  }, [roundPhase]); // eslint-disable-line react-hooks/exhaustive-deps

  // 70-second playing timer
  useLayoutEffect(() => {
    if (roundPhase !== 'playing') return;
    setRoundTimer(ROUND_PLAY_S);

    const triggerAnswer = (winnerId: string | null) => {
      setLastRoundVerse(currentVerse);
      setLastCorrectPlayerId(winnerId);
      setRoundPhase('answer');
    };

    const id = setInterval(() => {
      setRoundTimer(t => {
        if (t <= 1) { clearInterval(id); triggerAnswer(null); return 0; }
        return t - 1;
      });
    }, 1000);

    endRoundRef.current = (winnerId) => { clearInterval(id); triggerAnswer(winnerId); };

    return () => {
      clearInterval(id);
      endRoundRef.current = () => {};
    };
  }, [roundPhase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Called when AnswerRevealOverlay finishes
  const handleAnswerDone = useCallback(() => {
    const nextRound = roundNumber + 1;

    if (config.mode === 'elimination') {
      const active = controllers.filter(c => !eliminated.has(c.id));
      if (active.length > 1) {
        const sorted = [...active].sort((a, b) => (scores[a.id] ?? 0) - (scores[b.id] ?? 0));
        const loser = sorted[0];
        const nextElim = new Set([...eliminated, loser.id]);
        setEliminated(nextElim);
        if (active.length - 1 <= 1) { setGameOver(true); return; }
      } else {
        setGameOver(true); return;
      }
    }

    if (config.mode === 'rounds' && nextRound > config.roundCount) {
      setGameOver(true); return;
    }

    setCurrentVerseIdx(i => (i + 1) % Math.max(1, verses.length));
    setRoundNumber(r => r + 1);
    setRoundPhase('clearing');
  }, [roundNumber, config, controllers, eliminated, scores, verses.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    onSkipRef.current = () => {};
    onResultRef.current = (correct: boolean, playerId: string) => {
      setScores(prev => ({ ...prev, [playerId]: (prev[playerId] ?? 0) + (correct ? 1 : -1) }));
      if (correct) endRoundRef.current(playerId);
    };
  }, []);

  useLayoutEffect(() => {
    if (currentVerse) zoneHandle.current.setCurrentVerse(currentVerse);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loggedCtrlIds = useRef(new Set<string>());
  const handleFrame = useCallback((frame: ControllerFrame) => {
    for (const patch of frame.patches) {
      if (!loggedCtrlIds.current.has(patch.controllerId)) {
        loggedCtrlIds.current.add(patch.controllerId);
        console.debug('[GAME] first frame from controllerId=', patch.controllerId, 'id=', patch.id);
        console.debug('[GAME] controllers=', controllers.map(c => c.id));
      }
      const prev = inputsMap.current.get(patch.controllerId) ?? {};
      inputsMap.current.set(patch.controllerId, { ...prev, [patch.id]: patch.value });
    }
  }, [controllers]);

  useLayoutEffect(() => {
    gameOnInputRef.current = handleFrame;
    return () => { gameOnInputRef.current = () => {}; };
  }, [handleFrame, gameOnInputRef]);

  const colorMapRef = useRef<Record<string, string>>({});
  controllers.forEach(ctrl => {
    if (!colorMapRef.current[ctrl.id])
      colorMapRef.current[ctrl.id] = PALETTE[Object.keys(colorMapRef.current).length % PALETTE.length];
  });

  const activeControllers = controllers.filter(c => !eliminated.has(c.id));

  return (
    <div style={{position:'relative',width:'100%',height:'100%'}}>
      <ScoreHUD controllers={controllers} scores={scores} />
      {roundPhase === 'playing' && <RoundTimerHUD seconds={roundTimer} round={roundNumber} />}
      {roundPhase === 'intro' && (
        <RoundIntroOverlay
          round={roundNumber}
          verse={currentVerse}
          onDone={() => setRoundPhase('playing')}
        />
      )}
      {roundPhase === 'answer' && !gameOver && (
        <AnswerRevealOverlay
          verse={lastRoundVerse}
          winnerName={lastCorrectPlayerId
            ? (controllers.find(c => c.id === lastCorrectPlayerId)?.pseudo ?? lastCorrectPlayerId.slice(0, 6))
            : null}
          onDone={handleAnswerDone}
        />
      )}
      {gameOver && (
        <div style={{position:'absolute',inset:0,zIndex:100,display:'flex',flexDirection:'column',
          alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.94)',backdropFilter:'blur(8px)',
          fontFamily:'monospace'}}>
          <div style={{color:'#D4AC0D',fontSize:32,fontWeight:700,marginBottom:32,letterSpacing:2}}>
            Partie terminée
          </div>
          {[...controllers].sort((a,b)=>(scores[b.id]??0)-(scores[a.id]??0)).map((ctrl,i) => (
            <div key={ctrl.id} style={{color: i===0?'#D4AC0D':'#fff',fontSize:18,margin:'4px 0',
              opacity:eliminated.has(ctrl.id)?0.4:1}}>
              {i+1}. {ctrl.pseudo||ctrl.id.slice(0,6)} — {scores[ctrl.id]??0} pts
            </div>
          ))}
        </div>
      )}
      <Canvas shadows style={{width:'100%',height:'100%'}}
        camera={{fov:78,position:[0,CAM_H,CAM_Z],near:0.3,far:800}}>
        <VerseBattleScene
          controllers={activeControllers} inputsMap={inputsMap}
          colorMap={colorMapRef} onResult={onResultRef} onSkip={onSkipRef}
          zoneHandle={zoneHandle} batch={batchRef}
          enemyClear={enemyClearRef} boxClear={boxClearRef} panelClear={panelClearRef}
          onClearDone={onClearDoneRef} spawnEnabled={spawnEnabledRef} difficulty={difficultyRef}
          spawnQueue={spawnQueueRef} roomId={roomId}
        />
      </Canvas>
    </div>
  );
}
