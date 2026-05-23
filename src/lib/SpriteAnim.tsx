/**
 * SpriteAnimService — generic sprite-sheet animation service for R3F scenes.
 *
 * Usage (outside Canvas):
 *   SpriteAnimService.play(MY_ANIM, x, y, z);
 *
 * Usage (inside Canvas, once):
 *   <SpriteAnimLayer />
 *
 * Sheet layouts:
 *   - Horizontal strip (default): cols = frames, rows = 1
 *   - 2-D grid: set cols + rows explicitly, frames = cols * rows (or fewer if last row partial)
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// ── Definition ────────────────────────────────────────────────────────────────

export interface SpriteAnimDef {
  sheet:        string;
  frames:       number;              // total frames to play
  cols:         number;              // columns in sprite sheet
  rows?:        number;              // rows in sprite sheet (default 1)
  fps:          number;
  scale:        number | [number, number]; // fixed or [min, max] random
  billboard?:   boolean;             // default true
  randomRotation?: boolean;          // if true, sprite is randomly rotated
  renderOrder?: number;              // default 999
  depthTest?:   boolean;             // default false
}

// ── Singleton service ─────────────────────────────────────────────────────────

type PlayFn = (def: SpriteAnimDef, x: number, y: number, z: number) => void;
let _play: PlayFn = () => {};

export const SpriteAnimService = {
  play(def: SpriteAnimDef, x: number, y: number, z: number) {
    _play(def, x, y, z);
  },
};

// ── Internal types ────────────────────────────────────────────────────────────

interface AnimInstance {
  id:       number;
  def:      SpriteAnimDef;
  x: number; y: number; z: number;
  scale:    number;
  rotation: number;
}

let _nextId = 0;

// ── Shaders ───────────────────────────────────────────────────────────────────

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Grid shader — flipY=false so V=0 = image top.
// Use integer arithmetic to avoid mod/floor float precision bugs.
const FRAG = /* glsl */`
  uniform sampler2D uTex;
  uniform float     uFrame;
  uniform float     uCols;
  uniform float     uRows;
  varying vec2      vUv;

  void main() {
    int iFrame = int(uFrame);
    int iCols  = int(uCols);
    int col    = iFrame - (iFrame / iCols) * iCols;
    int row    = iFrame / iCols;
    float u = (float(col) + vUv.x) / uCols;
    float v = (float(row) + 1.0 - vUv.y) / uRows;
    vec4 c = texture2D(uTex, vec2(u, v));
    if (c.a < 0.01) discard;
    gl_FragColor = c;
  }
`;

// ── Single sprite component ───────────────────────────────────────────────────

function SpriteAnim({ inst, onDone }: { inst: AnimInstance; onDone: (id: number) => void }) {
  const { def, x, y, z, scale } = inst;
  const meshRef = useRef<THREE.Mesh>(null);
  const startMs = useRef(performance.now());
  const done    = useRef(false);

  const rows = def.rows ?? 1;

  const uniforms = useMemo(() => ({
    uTex:   { value: null as THREE.Texture | null },
    uFrame: { value: 0 },
    uCols:  { value: def.cols },
    uRows:  { value: rows },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const tex = new THREE.TextureLoader().load(def.sheet);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    uniforms.uTex.value = tex;
    return () => tex.dispose();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(({ camera }) => {
    const elapsed = (performance.now() - startMs.current) / 1000;
    const frame   = Math.floor(elapsed * def.fps);
    if (frame >= def.frames) {
      if (!done.current) { done.current = true; onDone(inst.id); }
      return;
    }
    uniforms.uFrame.value = frame;

    if (meshRef.current) {
      if (def.billboard ?? true) {
        meshRef.current.quaternion.copy(camera.quaternion);
      }
      if (inst.rotation !== 0) {
        meshRef.current.rotateZ(inst.rotation);
      }
    }
  });

  return (
    <mesh ref={meshRef} position={[x, y, z]} renderOrder={def.renderOrder ?? 999}>
      <planeGeometry args={[scale, scale]} />
      <shaderMaterial
        vertexShader={VERT}
        fragmentShader={FRAG}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        depthTest={def.depthTest ?? false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

// ── Layer (place once inside Canvas) ─────────────────────────────────────────

export function SpriteAnimLayer() {
  const [instances, setInstances] = useState<AnimInstance[]>([]);

  useLayoutEffect(() => {
    _play = (def, x, y, z) => {
      const raw   = def.scale;
      const scale = Array.isArray(raw)
        ? raw[0] + Math.random() * (raw[1] - raw[0])
        : raw;
      const rotation = def.randomRotation ? Math.random() * Math.PI * 2 : 0;
      setInstances(prev => [...prev, { id: _nextId++, def, x, y, z, scale, rotation }]);
    };
    return () => { _play = () => {}; };
  }, []);

  const remove = useCallback((id: number) => {
    setInstances(prev => prev.filter(i => i.id !== id));
  }, []);

  return (
    <>
      {instances.map(inst => (
        <SpriteAnim key={inst.id} inst={inst} onDone={remove} />
      ))}
    </>
  );
}
