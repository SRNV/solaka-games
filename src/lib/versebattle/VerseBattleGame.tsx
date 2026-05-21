import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, useTexture } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import { Physics, useBox } from '@react-three/cannon';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { ControllerDisplay } from '../../hooks/useGameRoom.ts';
import type { ControllerFrame, InputValue } from '../../types/inputs.ts';

type ControllerState = Record<string, InputValue>;

// ── Constants ─────────────────────────────────────────────────────────────────

const LANE_X       = [-24, -16, -8, 0, 8, 16, 24] as const;
const LANE_WIDTH   = 5.5;
const LANE_LENGTH  = 320;

const ZONE_MIN_Z   = 25;
const ZONE_MAX_Z   = 52;
const ZONE_WIDTH   = 64;
const PLAT_THICK   = 1;

const POOL_SIZE         = 60;
const MIN_ACTIVE        = 12;
const SPAWN_Z           = -80;
const ELIM_BOT_Z        = 58;
const ELIM_TOP_Z        = -85;
const ENM_MIN_R         = 0.8;
const ENM_MAX_R         = 3.5;
const SPAWN_INTERVAL_MS = 1200;

const P_RADIUS      = 1.5;
const P_SPEED       = 48;
const JUMP_VEL      = 12;
const FRICTION_RATE = 8;
const INVINCIBLE_MS = 3000;

const BEAM_RANGE   = 110;
const BEAM_TTL_MS  = 220;
const BEAM_PUSH    = 160;
const FIRE_HZ      = 8;
const CONE_HALF    = 0.06;

const LANE_BOUND_X = 24 + LANE_WIDTH / 2;

const PANEL_GROUPS  = [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6]] as const;
const PANEL_WIDTH   = 8 + LANE_WIDTH;
const PANEL_H       = 21.0;
const PANEL_D_MIN   = 5.0;
const PANEL_D_MAX   = PANEL_D_MIN * 4;
const PANEL_SPEED   = 10;
const PANEL_HZ      = 0.3;
const PANEL_POOL    = 24;
const EVAPORATE_MS  = 400;
const ZONE_ANIM_MS  = 300;

const PANEL_COLORS = [
  new THREE.Color(0xe74c3c).multiplyScalar(5),
  new THREE.Color(0x3498db).multiplyScalar(5),
  new THREE.Color(0xf39c12).multiplyScalar(5),
  new THREE.Color(0x9b59b6).multiplyScalar(5),
  new THREE.Color(0x1abc9c).multiplyScalar(5),
  new THREE.Color(0xe67e22).multiplyScalar(5),
];

const PALETTE = [
  '#e74c3c', '#3498db', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#e91e63', '#00bcd4',
];

// ── Types ─────────────────────────────────────────────────────────────────────

type SpawnBeam = (from: THREE.Vector3, to: THREE.Vector3) => void;

type EnemySlot = {
  active: boolean;
  pos: THREE.Vector3;
  vx: number;
  vz: number;
  baseVz: number;
  radius: number;
  meshIdx: number;
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

function CameraSetup() {
  const { camera } = useThree();
  useLayoutEffect(() => { camera.lookAt(0, 0, 5); }, [camera]);
  return null;
}

// ── Dynamic Terrain ───────────────────────────────────────────────────────────

const TERRAIN_SEG_W = 52;
const TERRAIN_SEG_L = 130;

function DynamicTerrain() {
  const geo = useMemo(() => {
    const g = new THREE.PlaneGeometry(ZONE_WIDTH + 4, LANE_LENGTH, TERRAIN_SEG_W, TERRAIN_SEG_L);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);

  useFrame(({ clock }) => {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const t   = clock.getElapsedTime();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);

      // Flatten inside the player zone so zones + physics look correct
      const flatBlend = z >= ZONE_MIN_Z - 6 && z <= ZONE_MAX_Z + 2
        ? Math.max(0, 1 - Math.max(0, z - (ZONE_MIN_Z - 6)) / 6) * 0.1
        : 1.0;

      const hills  = 1.1 * Math.sin(z * 0.055 + t * 0.42);
      const zigzag = 0.60 * Math.sin(z * 0.10 + x * 0.07 + t * 0.63)
                   + 0.35 * Math.sin(z * 0.17 - x * 0.05 + t * 0.48);
      const ripple = 0.28 * Math.cos(z * 0.27 + t * 1.05);

      pos.setY(i, flatBlend * (hills + zigzag + ripple));
    }

    pos.needsUpdate = true;
    geo.computeVertexNormals();
  });

  return (
    <>
      <mesh geometry={geo} receiveShadow>
        <meshStandardMaterial color={0x2a2a38} roughness={0.88} metalness={0.12} />
      </mesh>
      {/* Lane depth strips */}
      {LANE_X.map((x, i) => (
        <mesh key={`road-${i}`} position={[x, -0.2, 0]}>
          <boxGeometry args={[LANE_WIDTH, 0.4, LANE_LENGTH]} />
          <meshStandardMaterial color={0x1a1a26} roughness={0.95} />
        </mesh>
      ))}
      {/* Center lane stripes */}
      {LANE_X.map((x, i) => (
        <mesh key={`stripe-${i}`} position={[x, 0.02, 0]}>
          <boxGeometry args={[0.15, 0.02, LANE_LENGTH]} />
          <meshBasicMaterial color={0x444455} />
        </mesh>
      ))}
      {/* Player zone delimiter */}
      <mesh position={[0, 0.04, ZONE_MIN_Z]}>
        <boxGeometry args={[ZONE_WIDTH, 0.05, 0.3]} />
        <meshBasicMaterial color={0xffdd00} />
      </mesh>
    </>
  );
}

// ── Player platform (static physics body) ─────────────────────────────────────

function PlayerPlatform() {
  const depth = ZONE_MAX_Z - ZONE_MIN_Z;
  const [ref] = useBox<THREE.Mesh>(() => ({
    type: 'Static',
    args: [ZONE_WIDTH, PLAT_THICK, depth],
    position: [0, -PLAT_THICK / 2, (ZONE_MIN_Z + ZONE_MAX_Z) / 2],
    material: { restitution: 0.05, friction: 0.4 },
  }));
  return <mesh ref={ref} visible={false} />;
}

// ── EnemySphereManager ────────────────────────────────────────────────────────

const _mat4  = new THREE.Matrix4();
const _scale = new THREE.Vector3();
const _quat  = new THREE.Quaternion();
const _pos3  = new THREE.Vector3();

function EnemySphereManager({ handle }: { handle: React.MutableRefObject<EnemyHandle> }) {
  const meshRef     = useRef<THREE.InstancedMesh>(null);
  const slots       = useRef<EnemySlot[]>([]);
  const lastSpawnMs = useRef(0);
  const matcap      = useTexture('/assets/matcaps/unnamed/75746F_333330_A2A1A9_444444-64px.png');

  useLayoutEffect(() => {
    const arr: EnemySlot[] = [];
    for (let i = 0; i < POOL_SIZE; i++)
      arr.push({ active: false, pos: new THREE.Vector3(0, 1, SPAWN_Z),
        vx: 0, vz: 0, baseVz: 0, radius: 1, meshIdx: i });
    slots.current = arr;

    handle.current = {
      slots: arr,
      pushSlot(idx, fx, fz) {
        const s = arr[idx];
        if (!s.active) return;
        s.vx += fx; s.vz += fz;
      },
    };

    const mesh = meshRef.current;
    if (!mesh) return;
    _mat4.makeScale(0, 0, 0);
    for (let i = 0; i < POOL_SIZE; i++) mesh.setMatrixAt(i, _mat4);
    mesh.instanceMatrix.needsUpdate = true;

    return () => { handle.current = { slots: [], pushSlot: () => {} }; };
  }, [handle]); // eslint-disable-line react-hooks/exhaustive-deps

  function spawnOne() {
    const slot = slots.current.find(s => !s.active);
    if (!slot) return;
    const r   = Math.random() < 3 / 5 ? rnd(2.0, ENM_MAX_R) : rnd(ENM_MIN_R, 2.0);
    const base = Math.min(rnd(r ** 3, r ** 9), 80);
    slot.active = true;
    slot.pos.set(randLane() + rnd(-LANE_WIDTH * 0.3, LANE_WIDTH * 0.3), r, SPAWN_Z);
    slot.radius = r; slot.baseVz = base; slot.vz = base; slot.vx = 0;
  }

  useFrame((_, delta) => {
    const mesh  = slots.current;
    const imesh = meshRef.current;
    if (!imesh) return;

    const now = performance.now();
    let activeCount = 0;

    for (const s of mesh) {
      if (!s.active) continue;
      activeCount++;
      s.vz += (s.baseVz - s.vz) * Math.min(1, delta * 2.5);
      s.vx *= Math.exp(-delta * 2.0);
      s.pos.x += s.vx * delta;
      s.pos.z += s.vz * delta;

      if (s.pos.z > ELIM_BOT_Z || s.pos.z < ELIM_TOP_Z || Math.abs(s.pos.x) > LANE_BOUND_X) {
        s.active = false;
        _mat4.makeScale(0, 0, 0);
        imesh.setMatrixAt(s.meshIdx, _mat4);
        continue;
      }

      _scale.set(s.radius, s.radius, s.radius);
      _pos3.copy(s.pos);
      _mat4.compose(_pos3, _quat, _scale);
      imesh.setMatrixAt(s.meshIdx, _mat4);
    }

    // Sphere–sphere collision
    for (let i = 0; i < mesh.length; i++) {
      const a = mesh[i]; if (!a.active) continue;
      for (let j = i + 1; j < mesh.length; j++) {
        const b = mesh[j]; if (!b.active) continue;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const minD = a.radius + b.radius;
        if (dist >= minD || dist < 0.001) continue;
        const nx = dx / dist, nz = dz / dist;
        const ov = (minD - dist) * 0.5;
        a.pos.x -= nx * ov; a.pos.z -= nz * ov;
        b.pos.x += nx * ov; b.pos.z += nz * ov;
        const dvx = a.vx - b.vx, dvz = a.vz - b.vz;
        const dot = dvx * nx + dvz * nz;
        if (dot > 0) { a.vx -= dot * nx; a.vz -= dot * nz; b.vx += dot * nx; b.vz += dot * nz; }
      }
    }

    const canSpawn = now - lastSpawnMs.current > SPAWN_INTERVAL_MS;
    if (activeCount < MIN_ACTIVE && canSpawn) {
      for (let i = 0; i < MIN_ACTIVE - activeCount; i++) spawnOne();
      lastSpawnMs.current = now;
    } else if (activeCount < POOL_SIZE && canSpawn && Math.random() < 0.3) {
      spawnOne(); lastSpawnMs.current = now;
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

// ── BeamManager ───────────────────────────────────────────────────────────────

const BEAM_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
`;
const BEAM_FRAG = /* glsl */`
uniform sampler2D u_tex;
uniform float u_opacity;
uniform float u_scroll;
varying vec2 vUv;

vec3 rgb2hsv(vec3 c){vec4 K=vec4(0.,-1./3.,2./3.,-1.);vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));float d=q.x-min(q.w,q.y);return vec3(abs(q.z+(q.w-q.y)/(6.*d+1e-10)),d/(q.x+1e-10),q.x);}
vec3 hsv2rgb(vec3 c){vec4 K=vec4(1.,2./3.,1./3.,3.);vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www);return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y);}

void main(){
  float phase=fract(vUv.y*4.0-u_scroll);
  float onDuty=0.62;
  float mask=smoothstep(0.,0.08,phase)*(1.-smoothstep(onDuty,onDuty+0.06,phase));
  if(mask<0.01)discard;
  vec2 uv=vec2(vUv.x,clamp(phase/onDuty,0.,1.));
  vec4 col=texture2D(u_tex,uv);
  vec3 hsv=rgb2hsv(col.rgb); hsv.x=fract(hsv.x+30./360.); col.rgb=hsv2rgb(hsv);
  col.a*=u_opacity*mask;
  if(col.a<0.005)discard;
  gl_FragColor=col;
}
`;

const BEAM_W = 0.9;
type BeamRecord = { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; born: number; scroll: number; from: THREE.Vector3; norm: THREE.Vector3; length: number };

function BeamManager({ spawnRef }: { spawnRef: React.MutableRefObject<SpawnBeam> }) {
  const groupRef = useRef<THREE.Group>(null);
  const beams    = useRef<BeamRecord[]>([]);
  const texRef   = useRef<THREE.Texture | null>(null);
  const _va = new THREE.Vector3(), _vb = new THREE.Vector3(),
        _vc = new THREE.Vector3(), _vd = new THREE.Vector3(), _m4 = new THREE.Matrix4();

  useLayoutEffect(() => {
    new THREE.TextureLoader().load('/beams/image.png', tex => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      texRef.current = tex;
    });
  }, []);

  useLayoutEffect(() => {
    spawnRef.current = (from, to) => {
      const group = groupRef.current; if (!group) return;
      const dir = to.clone().sub(from);
      const length = Math.max(dir.length(), 0.1);
      const norm   = dir.clone().normalize();
      const mat = new THREE.ShaderMaterial({
        vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
        uniforms: { u_tex: { value: texRef.current }, u_opacity: { value: 1 }, u_scroll: { value: 0 } },
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(BEAM_W, length), mat);
      group.add(mesh);
      beams.current.push({ mesh, mat, born: performance.now(), scroll: 0, from: from.clone(), norm, length });
    };
    return () => { spawnRef.current = () => {}; };
  }, [spawnRef]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((state, delta) => {
    const now = performance.now(); const cam = state.camera.position;
    beams.current = beams.current.filter(b => {
      const age = now - b.born;
      if (age >= BEAM_TTL_MS) { groupRef.current?.remove(b.mesh); b.mesh.geometry.dispose(); b.mat.dispose(); return false; }
      b.scroll += delta * 1.8;
      b.mat.uniforms.u_scroll.value  = b.scroll;
      b.mat.uniforms.u_opacity.value = Math.sin((age / BEAM_TTL_MS) * Math.PI);
      if (!b.mat.uniforms.u_tex.value && texRef.current) b.mat.uniforms.u_tex.value = texRef.current;
      const mid = _va.copy(b.from).addScaledVector(b.norm, b.length / 2);
      _vb.copy(cam).sub(mid).normalize();
      _vc.crossVectors(b.norm, _vb); if (_vc.lengthSq() < 1e-6) return true; _vc.normalize();
      _vd.crossVectors(_vc, b.norm).normalize();
      _m4.set(_vc.x,b.norm.x,_vd.x,mid.x, _vc.y,b.norm.y,_vd.y,mid.y, _vc.z,b.norm.z,_vd.z,mid.z, 0,0,0,1);
      b.mesh.position.copy(mid); b.mesh.quaternion.setFromRotationMatrix(_m4);
      return true;
    });
  });

  return <group ref={groupRef} />;
}

// ── PlayerSphereBody ──────────────────────────────────────────────────────────

interface PlayerBodyProps {
  controller: ControllerDisplay;
  inputsMap: React.MutableRefObject<Map<string, ControllerState>>;
  enemyHandle: React.MutableRefObject<EnemyHandle>;
  spawnBeam: React.MutableRefObject<SpawnBeam>;
  playerPosRef: React.MutableRefObject<Map<string, THREE.Vector3>>;
  color: string;
  initPos: [number, number, number];
}

function PlayerSphereBody({ controller, inputsMap, enemyHandle, spawnBeam, playerPosRef, initPos }: PlayerBodyProps) {
  const meshRef  = useRef<THREE.Mesh>(null);
  const labelRef = useRef<THREE.Group>(null);
  const pos      = useRef(new THREE.Vector3(...initPos));
  const velX     = useRef(0);
  const velY     = useRef(0);
  const velZ     = useRef(0);
  const onGround    = useRef(false);
  const jumpCount   = useRef(0);
  const prevA       = useRef(false);
  const fireTimer   = useRef(0);
  const aimDir      = useRef<[number, number]>([0, -1]);
  const invUntil    = useRef(performance.now() + INVINCIBLE_MS);

  const FLOOR_Y = P_RADIUS;

  useLayoutEffect(() => {
    playerPosRef.current.set(controller.id, pos.current);
    return () => { playerPosRef.current.delete(controller.id); };
  }, [controller.id, playerPosRef]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((_, delta) => {
    const state = inputsMap.current.get(controller.id);
    const now   = performance.now();
    const p     = pos.current;

    // Gravity + floor
    velY.current -= 30 * delta;
    p.y += velY.current * delta;
    if (p.y <= FLOOR_Y) {
      p.y = FLOOR_Y; if (velY.current < 0) velY.current = 0;
      onGround.current = true; jumpCount.current = 0;
    } else { onGround.current = false; }

    // Respawn
    if (p.y < -10) {
      p.set(randLane(), FLOOR_Y, (ZONE_MIN_Z + ZONE_MAX_Z) / 2);
      velX.current = 0; velY.current = 0; velZ.current = 0;
      jumpCount.current = 0; onGround.current = true;
      invUntil.current = now + INVINCIBLE_MS;
    }

    // Invincibility blink
    const isInvincible = now < invUntil.current;
    if (meshRef.current) meshRef.current.visible = !isInvincible || Math.floor(now / 120) % 2 === 0;

    // Enemy collision
    if (!isInvincible) {
      for (const s of enemyHandle.current.slots) {
        if (!s.active) continue;
        const dx = p.x - s.pos.x, dy = p.y - s.pos.y, dz = p.z - s.pos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const minD = P_RADIUS + s.radius;
        if (dist >= minD || dist < 0.01) continue;
        const nx = dx / dist, nz = dz / dist;
        const pushF = 12 + s.radius * 4;
        velX.current += nx * pushF; velZ.current += nz * pushF;
        p.x += nx * (minD - dist); p.z += nz * (minD - dist);
      }
    }

    // Free X / Z movement
    const stick  = state?.stick_center;
    const stickX = stick?.type === 'axis2d' ? stick.x  : 0;
    const stickY = stick?.type === 'axis2d' ? -stick.y : 0;

    velX.current = Math.abs(stickX) > 0.1 ? stickX * P_SPEED : velX.current * Math.exp(-FRICTION_RATE * delta);
    p.x += velX.current * delta;
    p.x  = Math.max(-LANE_BOUND_X, Math.min(LANE_BOUND_X, p.x));

    velZ.current = Math.abs(stickY) > 0.1 ? stickY * P_SPEED : velZ.current * Math.exp(-FRICTION_RATE * delta);
    p.z += velZ.current * delta;

    // Z clamp to player zone
    if (p.z < ZONE_MIN_Z)            { p.z = ZONE_MIN_Z;            velZ.current = Math.max(0, velZ.current); }
    if (p.z > ZONE_MAX_Z - P_RADIUS) { p.z = ZONE_MAX_Z - P_RADIUS; velZ.current = Math.min(0, velZ.current); }

    // Jump
    const aDown = isPressed(state?.A);
    if (aDown && !prevA.current && jumpCount.current < 2) {
      velY.current = JUMP_VEL; jumpCount.current++; onGround.current = false;
    }
    prevA.current = aDown;

    // Aim
    const stickR = state?.stick_right;
    if (stickR?.type === 'axis2d') {
      const ax = stickR.x, az = -stickR.y;
      const len = Math.sqrt(ax * ax + az * az);
      if (len > 0.15) aimDir.current = [ax / len, az / len];
    }

    // Fire
    const stickL  = state?.stick_left;
    const firingL = stickL?.type === 'axis2d' && Math.sqrt(stickL.x ** 2 + stickL.y ** 2) > 0.15;
    const firingR = stickR?.type === 'axis2d' && Math.sqrt(stickR.x ** 2 + stickR.y ** 2) > 0.15;

    if (firingL || firingR) {
      fireTimer.current -= delta;
      if (fireTimer.current <= 0) {
        fireTimer.current = 1 / FIRE_HZ;
        const [adx, adz] = aimDir.current;
        const beamFrom = new THREE.Vector3(p.x + adx * P_RADIUS, p.y, p.z + adz * P_RADIUS);
        const beamEnd  = new THREE.Vector3(p.x + adx * BEAM_RANGE, p.y, p.z + adz * BEAM_RANGE);
        const eSlots = enemyHandle.current.slots;
        let closestDist = Infinity, closestIdx = -1;
        for (let i = 0; i < eSlots.length; i++) {
          const s = eSlots[i]; if (!s.active) continue;
          const dx = s.pos.x - p.x, dy = s.pos.y - p.y, dz = s.pos.z - p.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist > BEAM_RANGE || dist < 0.01 || dist >= closestDist) continue;
          if (dx * adx + dz * adz <= 0) continue;
          const dist2d = Math.sqrt(dx * dx + dz * dz);
          const sinAngle = Math.abs(dx * adz - dz * adx) / Math.max(dist2d, 0.01);
          const halfPlusR = Math.sin(CONE_HALF + Math.asin(Math.min(s.radius / Math.max(dist, s.radius), 1)));
          if (sinAngle > halfPlusR) continue;
          closestDist = dist; closestIdx = i;
        }
        if (closestIdx >= 0) enemyHandle.current.pushSlot(closestIdx, adx * BEAM_PUSH * (1 - closestDist / BEAM_RANGE), adz * BEAM_PUSH * (1 - closestDist / BEAM_RANGE));
        spawnBeam.current(beamFrom, beamEnd);
      }
    } else { fireTimer.current = 0; }

    if (meshRef.current)  meshRef.current.position.copy(p);
    if (labelRef.current) labelRef.current.position.set(p.x, p.y + P_RADIUS + 0.8, p.z);
  });

  const matcap = useTexture('/assets/matcaps/unnamed/75746F_333330_A2A1A9_444444-64px.png');
  const name   = controller.pseudo || controller.id.slice(0, 8);

  return (
    <>
      <mesh ref={meshRef} castShadow>
        <sphereGeometry args={[P_RADIUS, 28, 20]} />
        <meshMatcapMaterial matcap={matcap} />
      </mesh>
      <group ref={labelRef}>
        <Html center style={{ pointerEvents: 'none' }} zIndexRange={[1, 0]}>
          <span style={{ color:'#fff', fontFamily:'monospace', fontSize:13, fontWeight:700,
            textShadow:'0 0 5px #000,0 1px 3px #000', whiteSpace:'nowrap', userSelect:'none' }}>
            {name}
          </span>
        </Html>
      </group>
    </>
  );
}

// ── PanelManager (versets + zones) ────────────────────────────────────────────

type PanelSlot = {
  active: boolean; groupIdx: number; z: number; depth: number; meshIdx: number;
  born: number; zoneZ: number; zoneSpeed: number;
  zoneAnim: number; zoneEnterStart: number; zoneExiting: boolean; zoneExitStart: number;
  evaporating: boolean; evaporateStart: number; matched: boolean;
};

interface PanelManagerProps {
  playerPosRef: React.MutableRefObject<Map<string, THREE.Vector3>>;
  onScore: React.MutableRefObject<(id: string) => void>;
}

function PanelManager({ playerPosRef, onScore }: PanelManagerProps) {
  const slots       = useRef<PanelSlot[]>([]);
  const lastSpawnMs = useRef(0);
  const groupRefs   = useRef<(THREE.Group | null)[]>(new Array(PANEL_POOL).fill(null));
  const zoneRefs    = useRef<(THREE.Group | null)[]>(new Array(PANEL_POOL).fill(null));

  const edgesGeo     = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(PANEL_WIDTH, PANEL_H, 1)), []);
  const zoneEdgesGeo = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(PANEL_WIDTH, 1, 1)), []);

  const mats = useMemo(() => Array.from({ length: PANEL_POOL }, () =>
    new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2, transparent: true, opacity: 1 })), []);
  const zoneMats = useMemo(() => Array.from({ length: PANEL_POOL }, () =>
    new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 })), []);

  useLayoutEffect(() => {
    const arr: PanelSlot[] = [];
    for (let i = 0; i < PANEL_POOL; i++)
      arr.push({ active:false, groupIdx:0, z:SPAWN_Z, depth:PANEL_D_MIN, meshIdx:i,
        born:0, zoneZ:0, zoneSpeed:0, zoneAnim:0, zoneEnterStart:0,
        zoneExiting:false, zoneExitStart:0, evaporating:false, evaporateStart:0, matched:false });
    slots.current = arr;
  }, []);

  useFrame((_, delta) => {
    const now = performance.now();
    const arr = slots.current;

    for (const s of arr) {
      const grp  = groupRefs.current[s.meshIdx];
      const zone = zoneRefs.current[s.meshIdx];
      if (!grp || !zone) continue;

      if (!s.active) {
        grp.visible = false; zone.visible = false; continue;
      }

      // Verset evaporation
      if (s.evaporating) {
        const t = (now - s.evaporateStart) / EVAPORATE_MS;
        mats[s.meshIdx].opacity = Math.max(0, 1 - t);
        if (t >= 1) { s.active = false; grp.visible = false; zone.visible = false; mats[s.meshIdx].opacity = 1; }
        continue;
      }

      // Move verset
      s.z += PANEL_SPEED * delta;
      if (s.z > ELIM_BOT_Z) { s.active = false; grp.visible = false; zone.visible = false; continue; }

      const g  = PANEL_GROUPS[s.groupIdx];
      const cx = (LANE_X[g[0]] + LANE_X[g[1]]) / 2;

      // Verset grow-in
      const va = Math.min(1, (now - s.born) / ZONE_ANIM_MS);
      grp.visible = true;
      grp.position.set(cx, PANEL_H / 2, s.z);
      grp.scale.set(va, va, s.depth * va);

      // Zone drift + grow animation
      s.zoneZ += s.zoneSpeed * delta;
      s.zoneAnim = s.zoneExiting
        ? Math.max(0, 1 - (now - s.zoneExitStart) / ZONE_ANIM_MS)
        : Math.min(1, (now - s.zoneEnterStart) / ZONE_ANIM_MS);
      zone.visible = s.zoneAnim > 0;
      zone.position.set(cx, 0.05, s.zoneZ);
      zone.scale.set(s.zoneAnim, 1, s.depth * s.zoneAnim);

      // Match detection
      if (!s.matched && s.z >= s.zoneZ) {
        s.matched = true;
        s.zoneExiting = true; s.zoneExitStart = now;
        const hw = PANEL_WIDTH / 2 + P_RADIUS, hd = s.depth / 2 + P_RADIUS;
        for (const [id, ppos] of playerPosRef.current) {
          if (Math.abs(ppos.x - cx) > hw || Math.abs(ppos.z - s.zoneZ) > hd) continue;
          let blocked = false;
          for (const other of arr) {
            if (!other.active || other.matched || other.evaporating || other.born <= s.born) continue;
            const og = PANEL_GROUPS[other.groupIdx];
            const ocx = (LANE_X[og[0]] + LANE_X[og[1]]) / 2;
            if (Math.abs(ppos.x - ocx) <= PANEL_WIDTH / 2 + P_RADIUS &&
                Math.abs(ppos.z - other.zoneZ) <= other.depth / 2 + P_RADIUS) { blocked = true; break; }
          }
          if (!blocked) onScore.current(id);
        }
        s.evaporating = true; s.evaporateStart = now;
      }
    }

    // Spawn
    if (now - lastSpawnMs.current >= 1000 / PANEL_HZ) {
      const slot = arr.find(s => !s.active);
      if (slot) {
        const depth = PANEL_D_MIN + Math.random() * (PANEL_D_MAX - PANEL_D_MIN);
        const zMin  = ZONE_MIN_Z + depth / 2, zMax = ZONE_MAX_Z - depth / 2;
        const zoneZ = zMin + Math.random() * Math.max(0, zMax - zMin);
        const maxV  = (ZONE_MAX_Z - zoneZ) * PANEL_SPEED / (zoneZ - SPAWN_Z);
        Object.assign(slot, {
          active:true, groupIdx: Math.floor(Math.random() * PANEL_GROUPS.length),
          z:SPAWN_Z, depth, born:now, zoneZ, zoneSpeed: maxV * rnd(0.25, 0.75),
          zoneAnim:0, zoneEnterStart:now, zoneExiting:false, zoneExitStart:0,
          evaporating:false, matched:false,
        });
        mats[slot.meshIdx].opacity = 1;
        const col = PANEL_COLORS[Math.floor(Math.random() * PANEL_COLORS.length)];
        mats[slot.meshIdx].color.copy(col);
        zoneMats[slot.meshIdx].color.copy(col);
      }
      lastSpawnMs.current = now;
    }
  });

  return (
    <>
      {mats.map((mat, i) => (
        <group key={i} ref={el => { groupRefs.current[i] = el; }} visible={false}>
          <lineSegments geometry={edgesGeo} material={mat} />
        </group>
      ))}
      {zoneMats.map((mat, i) => (
        <group key={`z${i}`} ref={el => { zoneRefs.current[i] = el; }} visible={false}>
          <lineSegments geometry={zoneEdgesGeo} material={mat} />
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

function ScoreHUD({ controllers, scores }: { controllers: ControllerDisplay[]; scores: Record<string, number> }) {
  return (
    <div style={{ position:'absolute', top:12, left:'50%', transform:'translateX(-50%)',
      display:'flex', gap:24, pointerEvents:'none', zIndex:10 }}>
      {controllers.map(ctrl => (
        <div key={ctrl.id} style={{ background:'rgba(0,0,0,0.55)', border:'1px solid rgba(255,255,255,0.18)',
          borderRadius:8, padding:'4px 14px', color:'#fff', fontFamily:'monospace', fontWeight:700,
          textAlign:'center', minWidth:70 }}>
          <div style={{ fontSize:11, opacity:0.7, marginBottom:2 }}>{ctrl.pseudo || ctrl.id.slice(0,6)}</div>
          <div style={{ fontSize:28, lineHeight:1 }}>{scores[ctrl.id] ?? 0}</div>
        </div>
      ))}
    </div>
  );
}

// ── Scene ─────────────────────────────────────────────────────────────────────

function VerseBattleScene({ controllers, inputsMap, colorMap, onScore }: {
  controllers: ControllerDisplay[];
  inputsMap: React.MutableRefObject<Map<string, ControllerState>>;
  colorMap: React.MutableRefObject<Record<string, string>>;
  onScore: React.MutableRefObject<(id: string) => void>;
}) {
  const enemyHandle  = useRef<EnemyHandle>({ slots: [], pushSlot: () => {} });
  const spawnBeamRef = useRef<SpawnBeam>(() => {});
  const playerPosRef = useRef<Map<string, THREE.Vector3>>(new Map());

  return (
    <>
      <color attach="background" args={['#111118']} />
      <ambientLight intensity={0.4} />
      <directionalLight position={[20,60,40]} intensity={1.6} castShadow
        shadow-mapSize-width={2048} shadow-mapSize-height={2048}
        shadow-camera-left={-40} shadow-camera-right={40}
        shadow-camera-top={80} shadow-camera-bottom={-20}
        shadow-camera-near={1} shadow-camera-far={300} shadow-bias={-0.001} />
      <fog attach="fog" args={['#111118', 80, 200]} />

      <DynamicTerrain />
      <EnemySphereManager handle={enemyHandle} />
      <BeamManager spawnRef={spawnBeamRef} />

      <Physics gravity={[0,-30,0]} broadphase="SAP">
        <PlayerPlatform />
        {controllers.map(ctrl => (
          <PlayerSphere key={ctrl.id} controller={ctrl} inputsMap={inputsMap}
            enemyHandle={enemyHandle} spawnBeam={spawnBeamRef} playerPosRef={playerPosRef}
            color={colorMap.current[ctrl.id] ?? '#ffffff'} />
        ))}
      </Physics>

      <PanelManager playerPosRef={playerPosRef} onScore={onScore} />

      <EffectComposer>
        <Bloom luminanceThreshold={0.8} luminanceSmoothing={0.3} intensity={4.0} />
      </EffectComposer>
    </>
  );
}

// ── VerseBattleGame ───────────────────────────────────────────────────────────

export interface VerseBattleGameProps {
  controllers: ControllerDisplay[];
  gameOnInputRef: React.MutableRefObject<(frame: ControllerFrame) => void>;
}

export default function VerseBattleGame({ controllers, gameOnInputRef }: VerseBattleGameProps) {
  const inputsMap   = useRef<Map<string, ControllerState>>(new Map());
  const [scores, setScores] = useState<Record<string, number>>({});
  const addScoreRef = useRef<(id: string) => void>(() => {});

  useLayoutEffect(() => {
    addScoreRef.current = (id: string) =>
      setScores(prev => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }, []);

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

  const colorMapRef = useRef<Record<string, string>>({});
  controllers.forEach(ctrl => {
    if (!colorMapRef.current[ctrl.id]) {
      const n = Object.keys(colorMapRef.current).length;
      colorMapRef.current[ctrl.id] = PALETTE[n % PALETTE.length];
    }
  });

  return (
    <div style={{ position:'relative', width:'100%', height:'100%' }}>
      <ScoreHUD controllers={controllers} scores={scores} />
      <Canvas shadows style={{ width:'100%', height:'100%' }}
        camera={{ fov:55, position:[0,65,95], near:0.1, far:600 }}>
        <CameraSetup />
        <VerseBattleScene controllers={controllers} inputsMap={inputsMap}
          colorMap={colorMapRef} onScore={addScoreRef} />
      </Canvas>
    </div>
  );
}
