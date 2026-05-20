import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { Physics, useBox, useSphere } from '@react-three/cannon';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { ControllerDisplay } from '../../hooks/useGameRoom.ts';
import type { ControllerFrame, InputValue } from '../../types/inputs.ts';

type ControllerState = Record<string, InputValue>;

// ── Constantes ────────────────────────────────────────────────────────────────

const PLATFORM_HALF        = 50;
const PLATFORM_THICK       = 4;
const SPHERE_R             = 1.8;
const SPHERE_MASS          = 20;
const SPEED                = 15;
const JUMP_VEL             = 14;
const DASH_SPEED           = 94.55;
const DASH_DIST            = 12.4;
const DASH_PUSH_VEL        = 62;
const DASH_PUSH_ZONE       = 4.03;
const FRICTION_RATE        = 8;
const SIZE_STEP            = 0.4;
const MIN_RADIUS           = 0.6;
const MAX_RADIUS           = 5.0;
const FIRE_HZ_MAX          = 20;
const FIRE_HZ_MIN          = 1;
const BEAM_RANGE           = 80;
const BEAM_TTL_MS          = 230;
const BEAM_PUSH            = 25;
const CONE_MAX_ANGLE       = 0.45;

// ── Tuiles ────────────────────────────────────────────────────────────────────

const TILE_COUNT           = 60;
const TILE_SIZE            = (PLATFORM_HALF * 2) / TILE_COUNT; // ≈1.667m
const TILE_THICK           = 0.25;
const RING_FACTOR          = 1.33;
const TILE_FALL_DURATION   = 1200;  // ms d'animation de chute
const TILE_HP              = 100;   // points de vie par tuile
const WALK_DAMAGE_RATE     = 5.0;   // HP/s pour rayon SPHERE_R
const INVINCIBLE_DURATION  = 4000;  // ms d'intouchabilité au spawn
const RING_EFFECT_TTL      = 650;   // ms par effet d'anneau

const PALETTE = [
  '#e74c3c', '#3498db', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#e91e63', '#00bcd4',
];
const PALETTE_THREE = PALETTE.map(hex => new THREE.Color(hex));
const TILE_DEFAULT  = new THREE.Color(0x4caf50);
const COLOR_BLACK   = new THREE.Color(0x000000);

// ── Types ──────────────────────────────────────────────────────────────────────

type VelSetter = { set: (x: number, y: number, z: number) => void };
type SphereEntry = {
  posRef: React.MutableRefObject<[number, number, number]>;
  velRef: React.MutableRefObject<[number, number, number]>;
  velocity: VelSetter;
  radius: number;
};
type SpawnBeam = (from: THREE.Vector3, to: THREE.Vector3) => void;
type SpawnRing = (x: number, z: number, force: number, color: string) => void;

type TileInfo = {
  colorIdx: number;  // dernière couleur joueur (-1 = défaut)
  hp: number;        // 0-100
  fallenAt: number;  // timestamp ms, 0 = intact
};

type TileGridHandle = {
  applyDamage: (cx: number, cz: number, ringR: number, damage: number, colorIdx: number) => void;
  isFallen: (col: number, row: number) => boolean;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPressed(val: InputValue | undefined): boolean {
  if (!val) return false;
  return (val.type === 'button' || val.type === 'boolean') && val.pressed;
}

function sizeT(radius: number): number {
  return (radius - MIN_RADIUS) / (MAX_RADIUS - MIN_RADIUS);
}

// ── Camera ────────────────────────────────────────────────────────────────────

function CameraSetup() {
  const { camera } = useThree();
  useLayoutEffect(() => { camera.lookAt(0, 0, 0); }, [camera]);
  return null;
}

// ── Plateforme (physique invisible) ──────────────────────────────────────────

function Platform() {
  const args: [number, number, number] = [PLATFORM_HALF * 2, PLATFORM_THICK, PLATFORM_HALF * 2];
  const [ref] = useBox<THREE.Mesh>(() => ({
    type: 'Static',
    args,
    position: [0, TILE_THICK - PLATFORM_THICK / 2, 0],
    material: { restitution: 0.05, friction: 0.4 },
  }));
  return <mesh ref={ref} visible={false} />;
}

// ── TileGrid — grille 60×60, HP + assombrissement ────────────────────────────

function TileGrid({ gridRef }: { gridRef: React.MutableRefObject<TileGridHandle> }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const N = TILE_COUNT * TILE_COUNT;
  const infos = useRef<TileInfo[]>(
    Array.from({ length: N }, () => ({ colorIdx: -1, hp: TILE_HP, fallenAt: 0 }))
  );

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    for (let i = 0; i < N; i++) {
      const col = i % TILE_COUNT;
      const row = Math.floor(i / TILE_COUNT);
      m.makeTranslation(
        (col + 0.5) * TILE_SIZE - PLATFORM_HALF,
        TILE_THICK * 0.5,
        (row + 0.5) * TILE_SIZE - PLATFORM_HALF,
      );
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, TILE_DEFAULT);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const arr = infos.current;
    gridRef.current = {
      applyDamage(cx, cz, ringR, damage, colorIdx) {
        const mesh = meshRef.current;
        if (!mesh) return;
        const now = performance.now();
        const r2 = ringR * ringR;
        const c0 = Math.max(0, Math.floor((cx - ringR + PLATFORM_HALF) / TILE_SIZE));
        const c1 = Math.min(TILE_COUNT - 1, Math.floor((cx + ringR + PLATFORM_HALF) / TILE_SIZE) + 1);
        const r0 = Math.max(0, Math.floor((cz - ringR + PLATFORM_HALF) / TILE_SIZE));
        const r1 = Math.min(TILE_COUNT - 1, Math.floor((cz + ringR + PLATFORM_HALF) / TILE_SIZE) + 1);
        let dirty = false;
        for (let row = r0; row <= r1; row++) {
          for (let col = c0; col <= c1; col++) {
            const tcx = (col + 0.5) * TILE_SIZE - PLATFORM_HALF;
            const tcz = (row + 0.5) * TILE_SIZE - PLATFORM_HALF;
            if ((tcx - cx) ** 2 + (tcz - cz) ** 2 > r2) continue;
            const idx = row * TILE_COUNT + col;
            const tile = arr[idx];
            if (!tile || tile.fallenAt > 0) continue;
            tile.colorIdx = colorIdx;
            tile.hp = Math.max(0, tile.hp - damage);
            if (tile.hp <= 0) {
              tile.fallenAt = now;
            } else {
              const base = colorIdx >= 0
                ? PALETTE_THREE[colorIdx % PALETTE_THREE.length]
                : TILE_DEFAULT;
              // Assombrissement progressif selon les HP restants
              const factor = tile.hp / TILE_HP;
              const c = base.clone().lerp(COLOR_BLACK, 1 - factor);
              mesh.setColorAt(idx, c);
              dirty = true;
            }
          }
        }
        if (dirty && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      },

      isFallen(col, row) {
        const t = infos.current[row * TILE_COUNT + col];
        return !!t && t.fallenAt > 0;
      },
    };
  }, [gridRef]); // eslint-disable-line react-hooks/exhaustive-deps

  // Animation des tuiles qui tombent
  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const now = performance.now();
    const arr = infos.current;
    const m = new THREE.Matrix4();
    let matDirty = false;
    let colDirty = false;
    for (let i = 0; i < N; i++) {
      const tile = arr[i];
      if (tile.fallenAt <= 0) continue;
      const age = now - tile.fallenAt;
      if (age > TILE_FALL_DURATION) continue;
      const t = age / TILE_FALL_DURATION;
      const col = i % TILE_COUNT;
      const row = Math.floor(i / TILE_COUNT);
      const x = (col + 0.5) * TILE_SIZE - PLATFORM_HALF;
      const z = (row + 0.5) * TILE_SIZE - PLATFORM_HALF;
      m.makeTranslation(x, TILE_THICK * 0.5 - t * t * 40, z);
      mesh.setMatrixAt(i, m);
      matDirty = true;
      const base = tile.colorIdx >= 0
        ? PALETTE_THREE[tile.colorIdx % PALETTE_THREE.length]
        : TILE_DEFAULT;
      // Fondu noir lors de la chute
      const c = base.clone().lerp(COLOR_BLACK, 1 - Math.max(0, 1 - t));
      c.multiplyScalar(Math.max(0, 1 - t));
      mesh.setColorAt(i, c);
      colDirty = true;
    }
    if (matDirty) mesh.instanceMatrix.needsUpdate = true;
    if (colDirty && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, N]} castShadow receiveShadow>
      <boxGeometry args={[TILE_SIZE - 0.04, TILE_THICK, TILE_SIZE - 0.04]} />
      <meshStandardMaterial roughness={0.7} metalness={0.1} />
    </instancedMesh>
  );
}

// ── RingEffectManager — effets d'impact visuels ───────────────────────────────

type RingEffect = {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  born: number;
  maxR: number;
};

function RingEffectManager({ spawnRef }: { spawnRef: React.MutableRefObject<SpawnRing> }) {
  const groupRef = useRef<THREE.Group>(null);
  const effects  = useRef<RingEffect[]>([]);

  useLayoutEffect(() => {
    spawnRef.current = (x: number, z: number, force: number, color: string) => {
      const group = groupRef.current;
      if (!group) return;
      const maxR  = 1.2 + force * 0.45;
      const thick = Math.max(0.08, force * 0.04);
      const geo = new THREE.RingGeometry(0.05, 0.05 + thick, 48);
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 1.0,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, TILE_THICK + 0.06, z);
      group.add(mesh);
      effects.current.push({ mesh, mat, born: performance.now(), maxR });
    };
    return () => { spawnRef.current = () => {}; };
  }, [spawnRef]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(() => {
    const now = performance.now();
    effects.current = effects.current.filter(r => {
      const t = (now - r.born) / RING_EFFECT_TTL;
      if (t >= 1) {
        groupRef.current?.remove(r.mesh);
        r.mesh.geometry.dispose();
        r.mat.dispose();
        return false;
      }
      const s = r.maxR * t;
      r.mesh.scale.set(s, s, s);
      r.mat.opacity = Math.pow(1 - t, 0.6);
      return true;
    });
  });

  return <group ref={groupRef} />;
}

// ── BeamManager ───────────────────────────────────────────────────────────────

const BEAM_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BEAM_FRAG = /* glsl */`
uniform float u_progress;
uniform float u_opacity;
varying vec2 vUv;
void main() {
  float ballUv  = u_progress;
  float dist    = abs(vUv.y - ballUv);
  float glow    = max(0.0, 1.0 - dist / 0.07);
  glow          = pow(glow, 0.4);
  float alpha   = glow * u_opacity;
  if (alpha < 0.005) discard;
  gl_FragColor  = vec4(1.0, 1.0, 1.0, alpha);
}
`;

type BeamRecord = { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; born: number };

function BeamManager({ spawnRef }: { spawnRef: React.MutableRefObject<SpawnBeam> }) {
  const groupRef = useRef<THREE.Group>(null);
  const beams    = useRef<BeamRecord[]>([]);
  const _up      = new THREE.Vector3(0, 1, 0);

  useLayoutEffect(() => {
    spawnRef.current = (from: THREE.Vector3, to: THREE.Vector3) => {
      const group = groupRef.current;
      if (!group) return;
      const dir    = to.clone().sub(from);
      const length = Math.max(dir.length(), 0.1);
      const norm   = dir.clone().normalize();
      const geo = new THREE.CylinderGeometry(0.06, 0.06, length, 6, 24);
      const mat = new THREE.ShaderMaterial({
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        uniforms: { u_progress: { value: 0 }, u_opacity: { value: 1 } },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(from).addScaledVector(norm, length / 2);
      mesh.quaternion.setFromUnitVectors(_up, norm);
      group.add(mesh);
      beams.current.push({ mesh, mat, born: performance.now() });
    };
    return () => { spawnRef.current = () => {}; };
  }, [spawnRef]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(() => {
    const now = performance.now();
    beams.current = beams.current.filter(b => {
      const age = now - b.born;
      if (age >= BEAM_TTL_MS) {
        groupRef.current?.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.mat.dispose();
        return false;
      }
      const progress = age / BEAM_TTL_MS;
      b.mat.uniforms.u_progress.value = progress;
      b.mat.uniforms.u_opacity.value  = Math.sin(progress * Math.PI);
      return true;
    });
  });

  return <group ref={groupRef} />;
}

// ── Corps physique ────────────────────────────────────────────────────────────

interface SphereBodyProps {
  controller: ControllerDisplay;
  inputsMap: React.MutableRefObject<Map<string, ControllerState>>;
  sphereRegistry: React.MutableRefObject<Map<string, SphereEntry>>;
  spawnBeam: React.MutableRefObject<SpawnBeam>;
  spawnRing: React.MutableRefObject<SpawnRing>;
  tileGrid: React.MutableRefObject<TileGridHandle>;
  color: string;
  colorIdx: number;
  radius: number;
  initPos: [number, number, number];
  initVel: [number, number, number];
  invincibleUntil: React.MutableRefObject<number>;
  onResize: (newR: number, pos: [number, number, number], vel: [number, number, number]) => void;
}

function SphereBody({
  controller, inputsMap, sphereRegistry, spawnBeam, spawnRing, tileGrid,
  color, colorIdx, radius, initPos, initVel, invincibleUntil, onResize,
}: SphereBodyProps) {
  const jumpRef         = useRef(0);
  const velRef          = useRef<[number, number, number]>(initVel);
  const posRef          = useRef<[number, number, number]>(initPos);
  const prevA           = useRef(false);
  const prevB           = useRef(false);
  const prevC           = useRef(false);
  const prevR           = useRef(false);
  const lastDir         = useRef<[number, number]>([0, -1]);
  const dashRef         = useRef<{ dist: number; dir: [number, number] } | null>(null);
  const labelRef        = useRef<THREE.Group>(null);
  const ringRef         = useRef<THREE.Mesh>(null);
  const airborne        = useRef(false);
  const justLanded      = useRef(false);
  const fireTimer       = useRef(0);
  const coneAngle       = useRef(0);
  const aimDir          = useRef<[number, number]>([0, -1]);

  const [ref, api] = useSphere<THREE.Mesh>(() => ({
    mass: SPHERE_MASS,
    position: initPos,
    velocity: initVel,
    args: [radius],
    linearDamping: 0,
    angularDamping: 0.6,
    material: { restitution: 0.05, friction: 0.4 },
    onCollide: () => {
      if (velRef.current[1] <= 1.0) {
        if (airborne.current) justLanded.current = true;
        jumpRef.current = 0;
        airborne.current = false;
      }
    },
  }));

  useLayoutEffect(() => {
    sphereRegistry.current.set(controller.id, { posRef, velRef, velocity: api.velocity, radius });
    return () => { sphereRegistry.current.delete(controller.id); };
  }, [api, radius, controller.id, sphereRegistry]);

  useLayoutEffect(() => {
    const u1 = api.velocity.subscribe((v: number[]) => { velRef.current = v as [number, number, number]; });
    const u2 = api.position.subscribe((p: number[]) => { posRef.current = p as [number, number, number]; });
    return () => { u1(); u2(); };
  }, [api]);

  useFrame((_, delta) => {
    const state = inputsMap.current.get(controller.id);
    const [px, py, pz] = posRef.current;
    const now = performance.now();
    const isInvincible = now < invincibleUntil.current;
    const ringR = RING_FACTOR * radius;

    // ── Respawn si tombé sous la plateforme ───────────────────────────────────
    if (py < -15) {
      const sx = (Math.random() - 0.5) * PLATFORM_HALF * 0.6;
      const sz = (Math.random() - 0.5) * PLATFORM_HALF * 0.6;
      api.position.set(sx, TILE_THICK + radius + 3, sz);
      api.velocity.set(0, 0, 0);
      airborne.current = false;
      jumpRef.current  = 0;
      invincibleUntil.current = now + INVINCIBLE_DURATION;
      return;
    }

    // ── Détection trou (tuile tombée sous la sphère) ──────────────────────────
    if (py < TILE_THICK + radius + 0.3 && !isInvincible) {
      const col = Math.floor((px + PLATFORM_HALF) / TILE_SIZE);
      const row = Math.floor((pz + PLATFORM_HALF) / TILE_SIZE);
      if (col >= 0 && col < TILE_COUNT && row >= 0 && row < TILE_COUNT) {
        if (tileGrid.current.isFallen(col, row)) {
          api.position.set(px, TILE_THICK - PLATFORM_THICK - 3, pz);
          api.velocity.set(velRef.current[0] * 0.4, -15, velRef.current[2] * 0.4);
        }
      }
    }

    // ── Atterrissage : fort impact sur les tuiles ─────────────────────────────
    if (justLanded.current && !isInvincible) {
      justLanded.current = false;
      const impactVel = Math.abs(velRef.current[1]);
      if (impactVel > 2.0) {
        const t = sizeT(radius);
        const damage = (5 + t * 15) * Math.min(1, impactVel / JUMP_VEL);
        tileGrid.current.applyDamage(px, pz, ringR * 1.3, damage, colorIdx);
        spawnRing.current(px, pz, damage, color);
      }
    } else {
      justLanded.current = false;
    }

    // ── Clignotement pendant l'invincibilité ─────────────────────────────────
    if (ref.current) ref.current.visible = !isInvincible || Math.floor(now / 120) % 2 === 0;

    // ── Anneau lumineux au sol — invisible en l'air ou invincible ─────────────
    if (ringRef.current) {
      const showRing = !airborne.current && !isInvincible;
      ringRef.current.visible = showRing;
      ringRef.current.position.set(px, TILE_THICK + 0.03, pz);
    }

    // ── Dégâts continus au sol (pas en l'air, pas invincible) ─────────────────
    if (!airborne.current && !isInvincible) {
      const dmg = WALK_DAMAGE_RATE * (radius / SPHERE_R) * delta;
      tileGrid.current.applyDamage(px, pz, ringR, dmg, colorIdx);
    }

    // ── Label ────────────────────────────────────────────────────────────────
    if (labelRef.current)
      labelRef.current.position.set(px, py + radius + 0.8, pz);

    // ── Mouvement ────────────────────────────────────────────────────────────
    const stick = state?.stick_center;
    const hasInput = stick?.type === 'axis2d' && (Math.abs(stick.x) > 0.1 || Math.abs(stick.y) > 0.1);
    if (hasInput && stick?.type === 'axis2d') {
      const dx = stick.x, dz = -stick.y;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.01) lastDir.current = [dx / len, dz / len];
    }

    // ── Dash ─────────────────────────────────────────────────────────────────
    const rDown = isPressed(state?.R);
    if (rDown && !prevR.current && !dashRef.current && !airborne.current) {
      const [dx, dz] = lastDir.current;
      api.velocity.set(dx * DASH_SPEED, velRef.current[1], dz * DASH_SPEED);
      dashRef.current = { dist: 0, dir: [dx, dz] };
      // Dégâts dash sur les tuiles (proportionnel à la taille)
      if (!isInvincible) {
        const t = sizeT(radius);
        const dashDmg = t * 5;
        if (dashDmg > 0) {
          tileGrid.current.applyDamage(px, pz, ringR, dashDmg, colorIdx);
          spawnRing.current(px, pz, dashDmg + 1, color);
        }
      }
      // Push des autres sphères
      const zone = DASH_PUSH_ZONE * radius;
      for (const [otherId, entry] of sphereRegistry.current.entries()) {
        if (otherId === controller.id) continue;
        const ex = entry.posRef.current[0] - px;
        const ez = entry.posRef.current[2] - pz;
        const dist = Math.sqrt(ex * ex + ez * ez);
        if (dist < zone + entry.radius && dist > 0.01) {
          const nx = ex / dist, nz = ez / dist;
          entry.velocity.set(
            entry.velRef.current[0] + nx * DASH_PUSH_VEL,
            entry.velRef.current[1] + 2,
            entry.velRef.current[2] + nz * DASH_PUSH_VEL,
          );
        }
      }
    }
    prevR.current = rDown;

    if (dashRef.current) {
      const [ddx, ddz] = dashRef.current.dir;
      api.velocity.set(ddx * DASH_SPEED, velRef.current[1], ddz * DASH_SPEED);
      dashRef.current.dist += DASH_SPEED * delta;
      if (dashRef.current.dist >= DASH_DIST) {
        const decay = Math.exp(-FRICTION_RATE * delta);
        api.velocity.set(velRef.current[0] * decay, velRef.current[1], velRef.current[2] * decay);
        dashRef.current = null;
      }
    } else if (!airborne.current && hasInput && stick?.type === 'axis2d') {
      api.velocity.set(stick.x * SPEED, velRef.current[1], -stick.y * SPEED);
    }

    // ── Saut ─────────────────────────────────────────────────────────────────
    const aDown = isPressed(state?.A);
    if (aDown && !prevA.current && jumpRef.current < 2) {
      api.velocity.set(velRef.current[0], JUMP_VEL, velRef.current[2]);
      jumpRef.current++;
      airborne.current = true;
    }
    prevA.current = aDown;

    // ── Agrandir ─────────────────────────────────────────────────────────────
    const bDown = isPressed(state?.B);
    if (bDown && !prevB.current) {
      const newR = Math.round(Math.min(radius + SIZE_STEP, MAX_RADIUS) * 100) / 100;
      if (newR !== radius) onResize(newR, posRef.current, velRef.current);
    }
    prevB.current = bDown;

    // ── Réduire ───────────────────────────────────────────────────────────────
    const cDown = isPressed(state?.C);
    if (cDown && !prevC.current) {
      const newR = Math.round(Math.max(radius - SIZE_STEP, MIN_RADIUS) * 100) / 100;
      if (newR !== radius) onResize(newR, posRef.current, velRef.current);
    }
    prevC.current = cDown;

    // ── Cône (stick_left) ─────────────────────────────────────────────────────
    const stickL = state?.stick_left;
    if (stickL?.type === 'axis2d') {
      const mag = Math.sqrt(stickL.x * stickL.x + stickL.y * stickL.y);
      coneAngle.current = Math.min(mag, 1) * CONE_MAX_ANGLE;
    }

    // ── Tir (stick_right) ─────────────────────────────────────────────────────
    const stickR = state?.stick_right;
    if (stickR?.type === 'axis2d') {
      const aimX = stickR.x, aimZ = -stickR.y;
      const aimLen = Math.sqrt(aimX * aimX + aimZ * aimZ);
      if (aimLen > 0.15) {
        aimDir.current = [aimX / aimLen, aimZ / aimLen];
        const t = (radius - MIN_RADIUS) / (MAX_RADIUS - MIN_RADIUS);
        const hz = FIRE_HZ_MAX - (FIRE_HZ_MAX - FIRE_HZ_MIN) * Math.max(0, Math.min(1, t));
        fireTimer.current -= delta;
        if (fireTimer.current <= 0) {
          fireTimer.current = 1 / hz;
          const [adx, adz] = aimDir.current;
          const half = coneAngle.current;
          const rateScale = hz / FIRE_HZ_MAX;
          const shooterSpeed = Math.sqrt(velRef.current[0] ** 2 + velRef.current[2] ** 2);
          const pushScale = rateScale * Math.max(0.3, shooterSpeed / SPEED);
          let beamEnd = new THREE.Vector3(px + adx * BEAM_RANGE, py, pz + adz * BEAM_RANGE);
          let farthestDist = 0;
          for (const [otherId, entry] of sphereRegistry.current.entries()) {
            if (otherId === controller.id) continue;
            const [ox, oy, oz] = entry.posRef.current;
            const dx = ox - px, dy = oy - py, dz = oz - pz;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist > BEAM_RANGE) continue;
            if (dx * adx + dz * adz <= 0) continue;
            const dist2d = Math.sqrt(dx * dx + dz * dz);
            if (dist2d < 0.01) continue;
            const sinAngle = Math.abs(dx * adz - dz * adx) / dist2d;
            const halfWithRadius = Math.sin(half + Math.asin(Math.min(entry.radius / dist, 1)));
            if (sinAngle > halfWithRadius) continue;
            const nx = dx / dist, ny = dy / dist, nz = dz / dist;
            const force = BEAM_PUSH * pushScale * (1 - dist / BEAM_RANGE);
            entry.velocity.set(
              entry.velRef.current[0] + nx * force,
              entry.velRef.current[1] + ny * force * 0.4,
              entry.velRef.current[2] + nz * force,
            );
            if (dist > farthestDist) {
              farthestDist = dist;
              beamEnd = new THREE.Vector3(ox, oy, oz);
            }
          }
          const beamFrom = new THREE.Vector3(px + adx * radius, py, pz + adz * radius);
          spawnBeam.current(beamFrom, beamEnd);
        }
      } else {
        fireTimer.current = 0;
      }
    }
  });

  const name = controller.pseudo || controller.id.slice(0, 8);
  const ringInner = RING_FACTOR * radius * 0.9;
  const ringOuter = RING_FACTOR * radius * 1.1;

  return (
    <>
      <mesh ref={ref} castShadow>
        <sphereGeometry args={[radius, 32, 24]} />
        <meshStandardMaterial color={color} roughness={0.15} metalness={0.85} />
      </mesh>
      <group ref={labelRef}>
        <Html center style={{ pointerEvents: 'none' }} zIndexRange={[1, 0]}>
          <span style={{
            color: '#fff',
            fontFamily: 'monospace',
            fontSize: 13,
            fontWeight: 700,
            textShadow: '0 0 5px #000, 0 1px 3px #000',
            whiteSpace: 'nowrap',
            userSelect: 'none',
          }}>
            {name}
          </span>
        </Html>
      </group>
      {/* Anneau lumineux au sol — caché en l'air ou pendant l'invincibilité */}
      <mesh ref={ringRef} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[ringInner, ringOuter, 48]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.65}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </>
  );
}

// ── PlayerSphere ──────────────────────────────────────────────────────────────

interface PlayerSphereProps {
  controller: ControllerDisplay;
  inputsMap: React.MutableRefObject<Map<string, ControllerState>>;
  sphereRegistry: React.MutableRefObject<Map<string, SphereEntry>>;
  spawnBeam: React.MutableRefObject<SpawnBeam>;
  spawnRing: React.MutableRefObject<SpawnRing>;
  tileGrid: React.MutableRefObject<TileGridHandle>;
  color: string;
  colorIdx: number;
}

function PlayerSphere({ controller, inputsMap, sphereRegistry, spawnBeam, spawnRing, tileGrid, color, colorIdx }: PlayerSphereProps) {
  const initPos = useMemo<[number, number, number]>(() => [
    (Math.random() - 0.5) * PLATFORM_HALF * 0.6,
    TILE_THICK + SPHERE_R + 3,
    (Math.random() - 0.5) * PLATFORM_HALF * 0.6,
  ], []);

  const [radius, setRadius] = useState(SPHERE_R);
  const savedPos        = useRef<[number, number, number]>(initPos);
  const savedVel        = useRef<[number, number, number]>([0, 0, 0]);
  const invincibleUntil = useRef(performance.now() + INVINCIBLE_DURATION);

  const onResize = useCallback(
    (newR: number, pos: [number, number, number], vel: [number, number, number]) => {
      // Assure un dégagement suffisant pour éviter la pénétration initiale dans cannon.js
      savedPos.current = [pos[0], Math.max(pos[1], TILE_THICK + newR + 0.15), pos[2]];
      savedVel.current = [vel[0], 0, vel[2]];
      setRadius(newR);
    },
    [],
  );

  return (
    <SphereBody
      key={radius}
      controller={controller}
      inputsMap={inputsMap}
      sphereRegistry={sphereRegistry}
      spawnBeam={spawnBeam}
      spawnRing={spawnRing}
      tileGrid={tileGrid}
      color={color}
      colorIdx={colorIdx}
      radius={radius}
      initPos={savedPos.current}
      initVel={savedVel.current}
      invincibleUntil={invincibleUntil}
      onResize={onResize}
    />
  );
}

// ── Scene ─────────────────────────────────────────────────────────────────────

function MetelScene({ controllers, inputsMap, colorMap, colorIdxMap }: {
  controllers: ControllerDisplay[];
  inputsMap: React.MutableRefObject<Map<string, ControllerState>>;
  colorMap: React.MutableRefObject<Record<string, string>>;
  colorIdxMap: React.MutableRefObject<Record<string, number>>;
}) {
  const sphereRegistry = useRef<Map<string, SphereEntry>>(new Map());
  const spawnBeamRef   = useRef<SpawnBeam>(() => {});
  const spawnRingRef   = useRef<SpawnRing>(() => {});
  const tileGridRef    = useRef<TileGridHandle>({ applyDamage: () => {}, isFallen: () => false });

  return (
    <>
      <color attach="background" args={['#d0d0d0']} />
      <ambientLight intensity={0.5} />
      <directionalLight
        position={[40, 80, 40]}
        intensity={1.8}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-70}
        shadow-camera-right={70}
        shadow-camera-top={70}
        shadow-camera-bottom={-70}
        shadow-camera-near={1}
        shadow-camera-far={300}
        shadow-bias={-0.001}
      />
      <TileGrid gridRef={tileGridRef} />
      <BeamManager spawnRef={spawnBeamRef} />
      <RingEffectManager spawnRef={spawnRingRef} />
      <Physics gravity={[0, -30, 0]} broadphase="SAP">
        <Platform />
        {controllers.map(ctrl => (
          <PlayerSphere
            key={ctrl.id}
            controller={ctrl}
            inputsMap={inputsMap}
            sphereRegistry={sphereRegistry}
            spawnBeam={spawnBeamRef}
            spawnRing={spawnRingRef}
            tileGrid={tileGridRef}
            color={colorMap.current[ctrl.id] ?? '#ffffff'}
            colorIdx={colorIdxMap.current[ctrl.id] ?? 0}
          />
        ))}
      </Physics>
    </>
  );
}

// ── MetelGame ─────────────────────────────────────────────────────────────────

export interface MetelGameProps {
  controllers: ControllerDisplay[];
  gameOnInputRef: React.MutableRefObject<(frame: ControllerFrame) => void>;
}

export default function MetelGame({ controllers, gameOnInputRef }: MetelGameProps) {
  const inputsMap = useRef<Map<string, ControllerState>>(new Map());

  const handleFrame = useCallback((frame: ControllerFrame) => {
    for (const patch of frame.patches) {
      const prev = inputsMap.current.get(patch.controllerId) ?? {};
      inputsMap.current.set(patch.controllerId, { ...prev, [patch.id]: patch.value });
    }
  }, []);

  useLayoutEffect(() => {
    gameOnInputRef.current = handleFrame;
    return () => { gameOnInputRef.current = () => {}; };
  }, [handleFrame, gameOnInputRef]);

  const colorMapRef    = useRef<Record<string, string>>({});
  const colorIdxMapRef = useRef<Record<string, number>>({});
  controllers.forEach(ctrl => {
    if (!colorMapRef.current[ctrl.id]) {
      const n = Object.keys(colorMapRef.current).length;
      colorMapRef.current[ctrl.id]    = PALETTE[n % PALETTE.length];
      colorIdxMapRef.current[ctrl.id] = n % PALETTE.length;
    }
  });

  return (
    <Canvas
      shadows
      style={{ width: '100%', height: '100%' }}
      camera={{ fov: 60, position: [0, 90, 70], near: 0.1, far: 500 }}
    >
      <CameraSetup />
      <MetelScene
        controllers={controllers}
        inputsMap={inputsMap}
        colorMap={colorMapRef}
        colorIdxMap={colorIdxMapRef}
      />
    </Canvas>
  );
}
