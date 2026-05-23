import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, useTexture } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { ControllerDisplay } from '../../hooks/useGameRoom.ts';
import type { ControllerFrame, InputValue } from '../../types/inputs.ts';
import { SpriteAnimService, SpriteAnimLayer, type SpriteAnimDef } from '../SpriteAnim.tsx';
import { getGamesStompClient, isGamesStompConnected } from '../../gamesStompClient.ts';

type ControllerState = Record<string, InputValue>;

// ── Constants ─────────────────────────────────────────────────────────────────

const LANE_X       = [-24, -16, -8, 0, 8, 16, 24] as const;
const LANE_WIDTH   = 5.5;

const ZONE_MIN_Z   = 25;
const ZONE_MAX_Z   = 52;

const POOL_SIZE         = 60;
const MIN_ACTIVE        = 12;
const SPAWN_Z           = -280;
const ELIM_BOT_Z        = 58;
const ELIM_TOP_Z        = -320;
const ENM_MIN_R         = 0.8;
const ENM_MAX_R         = 3.5;
const SPAWN_INTERVAL_MS = 1200;

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
}

function getDifficulty(round: number): Difficulty {
  const r     = round - 1;
  const rampR = Math.max(0, round - 2);
  const pitchPattern = [0, 0, 0.2, 0.07, 0.5, 0.15, 0.7, 0.3, 1.0, 0.4];
  const pitchAmp = pitchPattern[Math.min(r, pitchPattern.length - 1)];
  // Roll gate probability: 0.25 at round 1 → 0.65 at round 20 (smooth gate, so feels natural)
  const rollGateProb = Math.min(0.65, 0.25 + r * (0.40 / 19));
  return {
    maxEnemies:     Math.min(POOL_SIZE, MIN_ACTIVE + r * 4),
    enemySizeScale: 1 + r * 0.15,
    maxBoxes:       Math.min(BOX_POOL, r * 2),
    maxPanels:      Math.min(7, Math.max(4, 1 + round)),
    rollAmpScale:   round <= 2 ? 0.08 : Math.min(2.5, 0.3 + rampR * 0.35),
    rollFreqScale:  round <= 2 ? 0.5  : Math.min(2.0, 0.8 + rampR * 0.12),
    rollGateProb,
    pitchAmpScale:  pitchAmp,
    pitchFreqScale: Math.min(2.0, 0.7 + rampR * 0.13),
  };
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

function applyRoll(lx: number, ly: number, t: number, z: number): [number, number] {
  const phi = rollAngle(t, z);
  const c = Math.cos(phi), s = Math.sin(phi);
  return [lx * c - ly * s, lx * s + ly * c];
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
function terrainY(localX: number, z: number, t: number): number {
  const ramp = Math.min(1, t / 90);
  const c1 = Math.max(0, Math.sin(z * 0.031 - t * 3.1));
  const c2 = Math.max(0, Math.sin(z * 0.019 - t * 1.9 + 2.3));
  const c3 = Math.max(0, Math.sin(z * 0.051 - t * 5.1 + 0.7));
  const env = c1 * c1 * 0.7 + c2 * c2 * 0.9 + c3 * c3 * 0.4;
  // Base undulation always present (gentle, doesn't ramp)
  const base = 0.4 * Math.sin(z * 0.05 - t * 5.0) + 0.2 * Math.sin(z * 0.031 + localX * 0.02 - t * 3.1);
  return base + ramp * env * (
    3.2  * Math.sin(z * 0.137  - t * 13.7) +
    2.1  * Math.sin(z * 0.0893 + localX * 0.04  - t *  8.93 + 1.57) +
    1.4  * Math.sin(z * 0.211  - localX * 0.061 - t * 21.1  + 0.83) +
    0.9  * Math.sin(z * 0.073  + localX * 0.029 - t *  7.3  + 3.14) +
    0.5  * Math.sin(z * 0.317  - localX * 0.08  - t * 31.7  + 2.0)
  );
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
    camPos.current.set(0, tyCam  + CAM_H,  CAM_Z);
    lookPos.current.set(0, tyLook + LOOK_H, LOOK_Z);
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
  const data = useMemo(() => Array.from({length: PARTICLE_COUNT}, () => ({
    x: rnd(-TERRAIN_W / 2, TERRAIN_W / 2),
    y: rnd(0, 28),
    z: rnd(TERRAIN_Z_OFF, ZONE_MAX_Z),
    size: rnd(0.08, 0.38),
  })), []);

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
      if (p.z > ZONE_MAX_Z + 10) {
        p.z = TERRAIN_Z_OFF + rnd(0, 20);
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
  return base + ramp * env * (
    3.2  * sin(z * 0.137  - uTime * 13.7) +
    2.1  * sin(z * 0.0893 + lx * 0.04  - uTime *  8.93 + 1.57) +
    1.4  * sin(z * 0.211  - lx * 0.061 - uTime * 21.1  + 0.83) +
    0.9  * sin(z * 0.073  + lx * 0.029 - uTime *  7.3  + 3.14) +
    0.5  * sin(z * 0.317  - lx * 0.08  - uTime * 31.7  + 2.0)
  );
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
  float wx = lx * cosP - ly * sinP;
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
  vec3  col  = vec3(0.11, 0.11, 0.17) * (0.38 + 0.72 * diff);

  // Lane dashes — boundaries at multiples of 8, scrolling toward player
  float lx        = vLocalX;
  float lanePos   = mod(lx + 28.0, 8.0); // distance to nearest boundary
  float laneDist  = min(lanePos, 8.0 - lanePos);
  float laneStripe = 1.0 - smoothstep(0.1, 0.35, laneDist);
  float dashPhase = mod(vWorldPos.z * 0.25 - uTime * 25.0, 1.0);
  float dash      = step(dashPhase, 0.55);
  col = mix(col, vec3(0.55, 0.55, 0.65), laneStripe * dash * 0.65);

  // Zone boundary stripe baked into terrain at ZONE_MIN_Z
  float zDist  = abs(vWorldPos.z - ${ZONE_MIN_Z}.0);
  float stripe = 1.0 - smoothstep(0.0, 0.6, zDist);
  col = mix(col, vec3(1.0, 0.87, 0.0), stripe);

  float dist = distance(vWorldPos, cameraPosition);
  float fog  = smoothstep(uFogNear, uFogFar, dist);
  gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
}
`;

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

  const FOG_COLOR = useMemo(() => new THREE.Color(0x0d0d14), []);
  const LIGHT_DIR = useMemo(() => new THREE.Vector3(20, 60, 40).normalize(), []);

  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader:   TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
    uniforms: {
      uTime:          { value: 0 },
      uRollAmpScale:  { value: 1 },
      uRollFreqScale: { value: 1 },
      uRollGateProb:  { value: 0.01 },
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
  });

  // frustumCulled=false: bounding box is computed pre-shader (flat plane),
  // which is wrong after vertex displacement + Z offset — would cull incorrectly.
  return <mesh geometry={geo} material={mat} frustumCulled={false} />;
}

// ── EnemySphereManager ────────────────────────────────────────────────────────

const _mat4  = new THREE.Matrix4();
const _scale = new THREE.Vector3();
const _pos3  = new THREE.Vector3();
const _squat = new THREE.Quaternion();

function EnemySphereManager({ handle, clearHandle, onClearDone, spawnEnabled, difficulty }: {
  handle: React.MutableRefObject<EnemyHandle>;
  clearHandle: React.MutableRefObject<ClearableHandle>;
  onClearDone: React.MutableRefObject<() => void>;
  spawnEnabled: React.MutableRefObject<boolean>;
  difficulty: React.MutableRefObject<Difficulty>;
}) {
  const meshRef      = useRef<THREE.InstancedMesh>(null);
  const slots        = useRef<EnemySlot[]>([]);
  const lastSpawnMs  = useRef(0);
  const isClearingRef = useRef(false);
  const matcap       = useTexture('/assets/matcaps/unnamed/75746F_333330_A2A1A9_444444-64px.png');

  useLayoutEffect(() => {
    const arr: EnemySlot[] = [];
    for (let i = 0; i < POOL_SIZE; i++)
      arr.push({ active:false, localX:0, z:SPAWN_Z, y:1, vx:0, vz:0, baseVz:0, radius:1, meshIdx:i, clearing:false, clearStart:0 });
    slots.current = arr;

    handle.current = {
      slots: arr,
      pushSlot(idx, fx, fz) { const s = arr[idx]; if (!s.active) return; s.vx += fx; s.vz += fz; },
    };

    clearHandle.current = {
      startClear() {
        const active = arr.filter(s => s.active && !s.clearing);
        if (active.length === 0) { onClearDone.current(); return; }
        const now = performance.now();
        active.forEach(s => { s.clearing = true; s.clearStart = now; });
        isClearingRef.current = true;
      },
    };

    const mesh = meshRef.current;
    if (!mesh) return;
    _mat4.makeScale(0, 0, 0);
    for (let i = 0; i < POOL_SIZE; i++) mesh.setMatrixAt(i, _mat4);
    mesh.instanceMatrix.needsUpdate = true;

    return () => { handle.current = { slots:[], pushSlot:()=>{} }; };
  }, [handle, clearHandle, onClearDone]); // eslint-disable-line react-hooks/exhaustive-deps

  function spawnOne(t: number, sizeScale: number) {
    const slot = slots.current.find(s => !s.active); if (!slot) return;
    const r    = (Math.random() < 0.6 ? rnd(2.0, ENM_MAX_R) : rnd(ENM_MIN_R, 2.0)) * sizeScale;
    // Speed close to terrain scroll (~100 u/s) with a small delta for variety
    const base = 100 + rnd(-15, 15);
    const lx   = randLane() + rnd(-LANE_WIDTH * 0.4, LANE_WIDTH * 0.4);
    const spawnZ = SPAWN_Z - rnd(0, 30);
    slot.active = true; slot.localX = lx; slot.z = spawnZ; slot.clearing = false;
    slot.y = terrainY(lx, spawnZ, t) + r;
    slot.radius = r; slot.baseVz = base; slot.vz = rnd(base * 0.5, base); slot.vx = 0;
  }

  useFrame((state, delta) => {
    const t     = state.clock.getElapsedTime();
    const now   = performance.now();
    const arr   = slots.current;
    const imesh = meshRef.current; if (!imesh) return;

    let activeCount = 0;
    for (const s of arr) {
      if (!s.active) continue;

      if (s.clearing) {
        const ct = Math.min(1, (now - s.clearStart) / CLEAR_MS);
        if (ct >= 1) {
          s.active = false; _mat4.makeScale(0,0,0); imesh.setMatrixAt(s.meshIdx, _mat4);
        } else {
          const sc = s.radius * (1 - ct);
          const [rwx, rwy] = applyRoll(s.localX, s.y, t, s.z);
          _scale.setScalar(sc); _pos3.set(rwx, rwy, s.z);
          _mat4.compose(_pos3, _squat, _scale);
          imesh.setMatrixAt(s.meshIdx, _mat4);
          activeCount++;
        }
        continue;
      }

      activeCount++;
      s.vz += (s.baseVz - s.vz) * Math.min(1, delta * 2.5);
      s.vx *= Math.exp(-delta * 2.0);
      s.localX += s.vx * delta;
      s.z      += s.vz * delta;
      s.y       = terrainY(s.localX, s.z, t) + s.radius;

      if (s.z > ELIM_BOT_Z || s.z < ELIM_TOP_Z || Math.abs(s.localX) > TERRAIN_W / 2) {
        s.active = false; _mat4.makeScale(0,0,0); imesh.setMatrixAt(s.meshIdx, _mat4); continue;
      }
      const [rwx, rwy] = applyRoll(s.localX, s.y, t, s.z);
      _scale.set(s.radius, s.radius, s.radius);
      _pos3.set(rwx, rwy, s.z);
      _mat4.compose(_pos3, surfaceQuat(s.localX, s.z, t, _squat), _scale);
      imesh.setMatrixAt(s.meshIdx, _mat4);
    }

    if (isClearingRef.current && !arr.some(s => s.active)) {
      isClearingRef.current = false;
      onClearDone.current();
    }

    for (let i = 0; i < arr.length; i++) {
      const a = arr[i]; if (!a.active || a.clearing) continue;
      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j]; if (!b.active || b.clearing) continue;
        const dx = b.localX - a.localX, dz = b.z - a.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const minD = a.radius + b.radius;
        if (dist >= minD || dist < 0.001) continue;
        const nx = dx / dist, nz = dz / dist, ov = (minD - dist) * 0.5;
        a.localX -= nx * ov; a.z -= nz * ov;
        b.localX += nx * ov; b.z += nz * ov;
        const dvx = a.vx - b.vx, dvz = a.vz - b.vz, dot = dvx * nx + dvz * nz;
        if (dot > 0) { a.vx -= dot * nx; a.vz -= dot * nz; b.vx += dot * nx; b.vz += dot * nz; }
      }
    }

    const diff     = difficulty.current;
    const maxE     = diff.maxEnemies;
    const canSpawn = spawnEnabled.current && now - lastSpawnMs.current > SPAWN_INTERVAL_MS;
    if (canSpawn && activeCount < maxE) {
      spawnOne(t, diff.enemySizeScale);
      lastSpawnMs.current = now;
    }
    imesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, POOL_SIZE]} castShadow>
      <sphereGeometry args={[1, 20, 16]} />
      <meshMatcapMaterial matcap={matcap} />
    </instancedMesh>
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
          const [wx, wy] = applyRoll(s.localX, localWy, t, s.z);
          _scale.set(1, scY, 1); _pos3.set(wx, wy, s.z);
          _mat4.compose(_pos3, surfaceQuat(s.localX, s.z, t, _squat), _scale);
          imesh.setMatrixAt(s.meshIdx, _mat4);
        }
        continue;
      }

      s.z += PANEL_SPEED * delta;
      if (s.z > ELIM_BOT_Z) { s.active = false; continue; }

      const localWy = terrainY(s.localX, s.z, t) + BOX_H / 2;
      const [wx, wy] = applyRoll(s.localX, localWy, t, s.z);

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
  color: string;
  initPos: [number, number, number];
}

function PlayerSphereBody({ controller, inputsMap, enemyHandle, spawnBeam, playerPosRef, boxHitRef, zoneHandle, initPos, roomId }: PlayerBodyProps) {
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
    if (p.z < ZONE_MIN_Z)            { p.z = ZONE_MIN_Z;            velZ.current = Math.max(0, velZ.current); }
    if (p.z > ZONE_MAX_Z - P_RADIUS) { p.z = ZONE_MAX_Z - P_RADIUS; velZ.current = Math.min(0, velZ.current); }

    // Jump + zone validate (A)
    const aDown = isPressed(input?.A);
    if (aDown && !prevA.current) {
      zoneHandle.current.tryValidate(controller.id, p.x, p.z);
      if (jumpCount.current < 2) {
        velY.current = JUMP_VEL; jumpCount.current++; onGround.current = false;
      }
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
    const [rendX, rendY] = applyRoll(p.x, p.y, t, p.z);
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
          const [sx] = applyRoll(s.localX, s.y, t, s.z);
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
      const [ringWx, ringWy] = applyRoll(p.x, groundLocalY, t, p.z);
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

// ── PanelManager ──────────────────────────────────────────────────────────────

type PanelSlot = {
  active:boolean; slotIdx:number; z:number; depth:number; meshIdx:number;
  born:number; zoneZ:number; zoneSpeed:number;
  zoneAnim:number; zoneEnterStart:number; zoneExiting:boolean; zoneExitStart:number;
  evaporating:boolean; evaporateStart:number; matched:boolean; colorIdx:number;
  wobble:boolean; wobbleVel:number; offsetX:number; verseUuid:string;
  clearing:boolean; clearStart:number;
};

interface PanelManagerProps {
  onResult: React.MutableRefObject<(correct: boolean, playerId: string) => void>;
  onImpact: React.MutableRefObject<(x: number, y: number, z: number) => void>;
  onSkip: React.MutableRefObject<() => void>;
  zoneHandle: React.MutableRefObject<ZoneHandle>;
  batch: React.MutableRefObject<GameVerse[]>;
  clearHandle: React.MutableRefObject<ClearableHandle>;
  onClearDone: React.MutableRefObject<() => void>;
  spawnEnabled: React.MutableRefObject<boolean>;
  difficulty: React.MutableRefObject<Difficulty>;
  playerPosRef: React.MutableRefObject<Map<string, THREE.Vector3>>;
}

function PanelManager({ onResult, onImpact, onSkip, zoneHandle, batch, clearHandle, onClearDone, spawnEnabled, difficulty, playerPosRef }: PanelManagerProps) {
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
        wobble:false,wobbleVel:0,offsetX:0,verseUuid:'',clearing:false,clearStart:0});
    slots.current = arr;

    zoneHandle.current = {
      tryValidate(playerId, playerX, playerZ) {
        const now = performance.now();
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
          break;
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
          const [vwx, vwy] = applyRoll(cx, terrainY(cx, s.z, t) + PANEL_H / 2, t, s.z);
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
          const [wx, wy_z] = applyRoll(cx, terrainY(cx, s.zoneZ, t) + 0.05, t, s.zoneZ);
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

      const [vwx, vwy] = applyRoll(cx, terrainY(cx, s.z, t) + PANEL_H / 2, t, s.z);
      const va  = Math.min(1, (now - s.born) / ZONE_ANIM_MS);
      grp.visible = true;
      grp.position.set(vwx, vwy, s.z);
      if (label)    label.position.set(vwx, vwy, s.z);
      if (labelDiv) labelDiv.style.display = 'block';
      grp.scale.set(va, va, s.depth * va);
      grp.quaternion.copy(surfaceQuat(cx, s.z, t, _squat));

      s.zoneZ += s.zoneSpeed * delta;
      s.zoneAnim = s.zoneExiting
        ? Math.max(0, 1 - (now - s.zoneExitStart) / ZONE_ANIM_MS)
        : Math.min(1, (now - s.zoneEnterStart) / ZONE_ANIM_MS);
      const [zwx, zwy] = applyRoll(cx, terrainY(cx, s.zoneZ, t) + 0.05, t, s.zoneZ);
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
    if (spawnEnabled.current && activePanels < difficulty.current.maxPanels &&
        now - lastSpawnMs.current >= 1000 / PANEL_HZ) {
      const slot = arr.find(s => !s.active);
      if (slot) {
        // Pick slot first so zone depth is computed relative to same-slot panels only.
        const usedSlots = new Set(arr.filter(s => s.active && !s.wobble).map(s => s.slotIdx));
        const freeSlots = PANEL_SLOT_X.map((_, i) => i).filter(i => !usedSlots.has(i));
        const wobble    = freeSlots.length === 0;
        const slotIdx   = wobble
          ? Math.floor(Math.random() * PANEL_SLOT_X.length)
          : freeSlots[Math.floor(Math.random() * freeSlots.length)];
        const wobbleVel = wobble ? rnd(PANEL_SPEED * 7, PANEL_SPEED * 10) * (Math.random() < 0.5 ? 1 : -1) : 0;

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

        // If slot is empty, use full zone with nominalDepth. Otherwise fit into free range.
        let depth = nominalDepth;
        let zoneZ = (ZONE_MIN_Z + ZONE_MAX_Z) / 2;
        if (occupiedIntervals.length > 0) {
          const validRanges = freeRanges.filter(([a, b]) => b - a >= minDepth);
          if (validRanges.length > 0) {
            const [ra, rb] = validRanges[Math.floor(Math.random() * validRanges.length)];
            depth = Math.min(rb - ra, nominalDepth);
            const halfD = depth / 2;
            zoneZ = (ra + halfD) + Math.random() * Math.max(0, (rb - halfD) - (ra + halfD));
          }
        }

        const maxV    = (ZONE_MAX_Z - zoneZ) * PANEL_SPEED / (zoneZ - SPAWN_Z);
        const zoneSpeed = maxV * rnd(0.25, 0.28);

        const b = batch.current;
        const verseForSlot = b.length > 0 ? b[Math.floor(Math.random() * b.length)] : null;

        Object.assign(slot, {
          active:true, slotIdx,
          z:SPAWN_Z, depth, born:now, zoneZ, zoneSpeed,
          zoneAnim:0, zoneEnterStart:now, zoneExiting:false, zoneExitStart:0,
          evaporating:false, matched:false, offsetX:0, wobble, wobbleVel,
          verseUuid: verseForSlot?.uuid ?? '', clearing:false, clearStart:0,
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
        const span = labelSpanRefs.current[slot.meshIdx];
        if (span && verseForSlot) {
          const css = PANEL_CSS_COLORS[colorIdx];
          span.style.textShadow = `0 0 8px ${css},0 0 22px ${css}`;
          span.textContent = `${verseForSlot.bookName} ${verseForSlot.chapterNumber}:${verseForSlot.verseNumber}`;
        }
      }
      lastSpawnMs.current = now;
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

function RoundIntroOverlay({ round, verse, onDone }: { round: number; verse: GameVerse | null; onDone: () => void }) {
  const [countdown, setCountdown] = useState(ROUND_INTRO_S);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useLayoutEffect(() => {
    setCountdown(ROUND_INTRO_S);
    const id = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { clearInterval(id); setTimeout(() => doneRef.current(), 0); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [round]); // reset when round changes

  return (
    <div style={{position:'absolute',inset:0,zIndex:50,display:'flex',flexDirection:'column',
      alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.88)',backdropFilter:'blur(6px)',
      pointerEvents:'none'}}>
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
  enemyClear, boxClear, panelClear, onClearDone, spawnEnabled, difficulty, roomId }: {
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
  roomId: string;
}) {
  const enemyHandle  = useRef<EnemyHandle>({ slots:[], pushSlot:()=>{} });
  const spawnBeamRef = useRef<SpawnBeam>(() => {});
  const playerPosRef = useRef<Map<string, THREE.Vector3>>(new Map());
  const boxHitRef    = useRef<Map<string, number>>(new Map());
  const onImpactRef  = useRef((x: number, y: number, z: number) => {
    SpriteAnimService.play(WRONG_ANSWER_ANIM, x, y, z);
  });

  const handleBoxHit = useCallback((id: string, nx: number) => {
    boxHitRef.current.set(id, (boxHitRef.current.get(id) ?? 0) + nx);
  }, []);

  return (
    <>
      <color attach="background" args={['#0d0d14']} />
      <ambientLight intensity={0.35} />
      <directionalLight position={[20,60,40]} intensity={1.6} castShadow
        shadow-mapSize-width={2048} shadow-mapSize-height={2048}
        shadow-camera-left={-60} shadow-camera-right={60}
        shadow-camera-top={100} shadow-camera-bottom={-30}
        shadow-camera-near={1} shadow-camera-far={300} shadow-bias={-0.001} />
      <fog attach="fog" args={['#0d0d14', 180, 700]} />

      <CameraRig />
      <ParticleField />
      <DynamicTerrain />
      <EnemySphereManager handle={enemyHandle} clearHandle={enemyClear}
        onClearDone={onClearDone} spawnEnabled={spawnEnabled} difficulty={difficulty} />
      <BeamManager spawnRef={spawnBeamRef} />
      <BoxObstacleManager playerPosRef={playerPosRef} onHit={handleBoxHit}
        clearHandle={boxClear} onClearDone={onClearDone} spawnEnabled={spawnEnabled} difficulty={difficulty} />

      {controllers.map(ctrl => (
        <PlayerSphere key={ctrl.id} controller={ctrl} inputsMap={inputsMap}
          enemyHandle={enemyHandle} spawnBeam={spawnBeamRef} playerPosRef={playerPosRef}
          boxHitRef={boxHitRef} zoneHandle={zoneHandle} roomId={roomId}
          color={colorMap.current[ctrl.id] ?? '#ffffff'} />
      ))}

      <PanelManager onResult={onResult} onImpact={onImpactRef} onSkip={onSkip} zoneHandle={zoneHandle} batch={batch}
        clearHandle={panelClear} onClearDone={onClearDone} spawnEnabled={spawnEnabled} difficulty={difficulty}
        playerPosRef={playerPosRef} />
      <SpriteAnimLayer />

      <EffectComposer>
        <Bloom luminanceThreshold={0.8} luminanceSmoothing={0.3} intensity={4.0} />
      </EffectComposer>
    </>
  );
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
}

export default function VerseBattleGame({ controllers, gameOnInputRef, verses, roomId }: VerseBattleGameProps) {
  const inputsMap = useRef<Map<string, ControllerState>>(new Map());
  const [scores, setScores]                   = useState<Record<string, number>>({});
  const [currentVerseIdx, setCurrentVerseIdx] = useState(0);
  const [roundNumber, setRoundNumber]         = useState(1);
  const [roundPhase, setRoundPhase]           = useState<'clearing'|'intro'|'playing'>('intro');
  const [roundTimer, setRoundTimer]           = useState(ROUND_PLAY_S);

  const currentVerse = verses.length > 0 ? verses[currentVerseIdx % verses.length] : null;

  const clearedCount    = useRef(0);
  const onClearDoneRef  = useRef<() => void>(() => {});
  const enemyClearRef   = useRef<ClearableHandle>({ startClear: () => {} });
  const boxClearRef     = useRef<ClearableHandle>({ startClear: () => {} });
  const panelClearRef   = useRef<ClearableHandle>({ startClear: () => {} });
  const spawnEnabledRef = useRef(false);
  const difficultyRef   = useRef<Difficulty>(getDifficulty(1));
  const batchRef        = useRef<GameVerse[]>([]);
  const endRoundRef     = useRef<() => void>(() => {});

  const zoneHandle  = useRef<ZoneHandle>({ tryValidate:()=>{}, getZoneColor:()=>null, setCurrentVerse:()=>{} });
  const onResultRef = useRef<(correct: boolean, playerId: string) => void>(() => {});
  const onSkipRef   = useRef<() => void>(() => {});

  // Update difficulty, roll and pitch params on new round
  useLayoutEffect(() => {
    const d = getDifficulty(roundNumber);
    difficultyRef.current  = d;
    _rollParams.ampScale   = d.rollAmpScale;
    _rollParams.freqScale  = d.rollFreqScale;
    _rollParams.gateProb   = d.rollGateProb;
    _pitchParams.ampScale  = d.pitchAmpScale;
    _pitchParams.freqScale = d.pitchFreqScale;
  }, [roundNumber]);

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
      // Build batch: correct verse + (maxPanels-1) false verses, randomly picked
      const cv = currentVerse;
      if (cv && verses.length > 0) {
        const d = difficultyRef.current;
        const falsePool = verses.filter(v => v.uuid !== cv.uuid);
        const falseCount = Math.max(0, d.maxPanels - 1);
        const batch: GameVerse[] = [cv];
        for (let i = 0; i < falseCount && falsePool.length > 0; i++)
          batch.push(falsePool[Math.floor(Math.random() * falsePool.length)]);
        batchRef.current = batch;
        zoneHandle.current.setCurrentVerse(cv);
      }
    } else if (roundPhase === 'playing') {
      spawnEnabledRef.current = true;
    }
  }, [roundPhase]); // eslint-disable-line react-hooks/exhaustive-deps

  // 70-second playing timer — also ends on correct answer via endRoundRef
  useLayoutEffect(() => {
    if (roundPhase !== 'playing') return;
    setRoundTimer(ROUND_PLAY_S);

    const triggerNextRound = () => {
      setCurrentVerseIdx(i => (i + 1) % Math.max(1, verses.length));
      setRoundNumber(r => r + 1);
      setRoundPhase('clearing');
    };

    const id = setInterval(() => {
      setRoundTimer(t => {
        if (t <= 1) { clearInterval(id); triggerNextRound(); return 0; }
        return t - 1;
      });
    }, 1000);

    endRoundRef.current = () => { clearInterval(id); triggerNextRound(); };

    return () => {
      clearInterval(id);
      endRoundRef.current = () => {};
    };
  }, [roundPhase]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    onSkipRef.current = () => {}; // correct panel passes through → will reappear from batch
    onResultRef.current = (correct: boolean, playerId: string) => {
      setScores(prev => ({ ...prev, [playerId]: (prev[playerId] ?? 0) + (correct ? 1 : -1) }));
      if (correct) endRoundRef.current();
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
      <Canvas shadows style={{width:'100%',height:'100%'}}
        camera={{fov:78,position:[0,CAM_H,CAM_Z],near:0.3,far:800}}>
        <VerseBattleScene
          controllers={controllers} inputsMap={inputsMap}
          colorMap={colorMapRef} onResult={onResultRef} onSkip={onSkipRef}
          zoneHandle={zoneHandle} batch={batchRef}
          enemyClear={enemyClearRef} boxClear={boxClearRef} panelClear={panelClearRef}
          onClearDone={onClearDoneRef} spawnEnabled={spawnEnabledRef} difficulty={difficultyRef}
          roomId={roomId}
        />
      </Canvas>
    </div>
  );
}
