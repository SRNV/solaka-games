import { useRef, useMemo, useState, useLayoutEffect, useEffect, forwardRef, useImperativeHandle } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF, Clone } from '@react-three/drei';
import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { SvgZone, SvgZoneExtra } from '../../hooks/useSvgZones.ts';
import type { Zone } from '../gamepad3d/useZones.ts';
import type { GamepadTheme } from '../gamepad3d/themes.ts';
import type { GamepadInputHandle } from '../gamepad3d/useGamepadInput.ts';
import { CAM_H } from '../gamepad3d/useZones.ts';

type AnyZone = Zone & { svgExtra?: SvgZoneExtra };

interface Particle {
  id: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  color: string;
}

export interface SvgGamepadSceneHandle {
  triggerExplosion: (x: number, y: number, color: string, zoneId: string) => void;
  /** Raycasts from screen coordinates to find the hit zoneKey */
  hitTest: (cx: number, cy: number) => string | null;
}

interface Props {
  zones: AnyZone[];
  input: GamepadInputHandle;
  theme: GamepadTheme;
  /** Matrix4 mapping SVG coordinates → R3F world space */
  svgToWorldMatrix: THREE.Matrix4;
  /** Viewport of the SVG for centering logic */
  viewportCenter?: { x: number; y: number };
  matcapTexture?: THREE.Texture | null;
  outlineColor?: string;
  isStandalone?: boolean;
}

/**
 * Converts SVG markup (outerHTML of an element, transforms included) into ExtrudeGeometry.
 */
function pathToGeometry(svgMarkup: string): THREE.BufferGeometry | null {
  try {
    const loader = new SVGLoader();
    const result = loader.parse(
      `<svg xmlns="http://www.w3.org/2000/svg">${svgMarkup}</svg>`,
    );
    const shapes: THREE.Shape[] = [];
    for (const path of result.paths) {
      shapes.push(...SVGLoader.createShapes(path));
    }
    if (!shapes.length) return null;

    const geometry = new THREE.ExtrudeGeometry(shapes, {
      depth: 5,
      bevelEnabled: true,
      bevelThickness: 0.5,
      bevelSize: 0.5,
      bevelSegments: 1,
    });
    geometry.center();
    return geometry;
  } catch {
    return null;
  }
}

// Slightly curved background plane — spherical displacement produces a center
// highlight gradient similar to the joystick dome shading. Sized to always fill
// the full canvas regardless of aspect ratio.
function BackgroundPanel({ color, matcapTexture }: { color: string; matcapTexture?: THREE.Texture | null }) {
  const { size } = useThree();

  const geo = useMemo(() => {
    const aspect = (size.width > 0 && size.height > 0) ? size.width / size.height : 16 / 9;
    const worldW = CAM_H * 2 * aspect + 2;
    const worldH = CAM_H * 2 + 2;
    const segsW  = Math.max(1, Math.ceil(worldW * 4));
    const segsH  = Math.max(1, Math.ceil(worldH * 4));
    const plane  = new THREE.PlaneGeometry(worldW, worldH, segsW, segsH);
    const pos    = plane.attributes.position as THREE.BufferAttribute;
    const R = 80;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      pos.setZ(i, Math.sqrt(Math.max(0, R * R - x * x - y * y)) - R);
    }
    pos.needsUpdate = true;
    plane.computeVertexNormals();
    return plane;
  }, [size.width, size.height]);

  useEffect(() => () => { geo.dispose(); }, [geo]);

  return (
    <mesh geometry={geo} position={[0, 0, -3]}>
      {matcapTexture
        ? <meshBasicMaterial key={matcapTexture.uuid} map={matcapTexture} />
        : <meshStandardMaterial key="standard" color={color} roughness={0.7} metalness={0.1} />
      }
    </mesh>
  );
}

// Replaces R3F's default render with EffectComposer + OutlinePass.
// useFrame with priority > 0 skips R3F's built-in gl.render() call.
function OutlineEffect({ meshesRef, outlineColor = '#ffffff' }: {
  meshesRef: React.MutableRefObject<Map<string, THREE.Mesh>>;
  outlineColor?: string;
}) {
  const { gl, scene, camera, size } = useThree();
  const composerRef    = useRef<EffectComposer | null>(null);
  const outlinePassRef = useRef<OutlinePass | null>(null);

  useEffect(() => {
    const composer    = new EffectComposer(gl);
    const renderPass  = new RenderPass(scene, camera);
    const outlinePass = new OutlinePass(new THREE.Vector2(size.width, size.height), scene, camera);
    outlinePass.edgeStrength  = 3.0;
    outlinePass.edgeThickness = 1.0;
    outlinePass.edgeGlow      = 0.0;
    outlinePass.pulsePeriod   = 0;
    outlinePass.visibleEdgeColor.set(outlineColor);
    outlinePass.hiddenEdgeColor.set(0x333333);
    composer.addPass(renderPass);
    composer.addPass(outlinePass);
    composer.addPass(new OutputPass());
    composerRef.current    = composer;
    outlinePassRef.current = outlinePass;
    return () => composer.dispose();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera]);

  useEffect(() => {
    composerRef.current?.setSize(size.width, size.height);
  }, [size.width, size.height]);

  useEffect(() => {
    outlinePassRef.current?.visibleEdgeColor.set(outlineColor);
  }, [outlineColor]);

  useFrame(() => {
    if (!composerRef.current || !outlinePassRef.current) return;
    const meshes = Array.from(meshesRef.current.values());
    // Update selected objects every frame to ensure we don't have stale/disposed references
    outlinePassRef.current.selectedObjects = meshes;
    composerRef.current.render();
  }, 1);

  return null;
}

function JoystickGLB({ 
  scale, 
  matcapTexture,
  color,
  isMetallic,
  isPressed,
  zoneKey, 
  meshesRef, 
  renderOrder 
}: { 
  scale: number;
  matcapTexture?: THREE.Texture | null;
  color: string;
  isMetallic: boolean;
  isPressed: boolean;
  zoneKey: string;
  meshesRef: React.MutableRefObject<Map<string, THREE.Object3D>>;
  renderOrder?: number;
}) {
  const { scene } = useGLTF('/joystick.glb');

  const material = useMemo(() => {
    if (matcapTexture) {
      return new THREE.MeshMatcapMaterial({ 
        matcap: matcapTexture,
        side: THREE.DoubleSide
      });
    }
    return new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.5,
      roughness: isMetallic ? 0.1 : 0.3,
      metalness: isMetallic ? 0.9 : 0.2,
      side: THREE.DoubleSide
    });
  }, [matcapTexture, color, isMetallic]);

  const clonedScene = useMemo(() => {
    const clone = scene.clone(true);
    clone.traverse(child => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.material = material;
        mesh.renderOrder = renderOrder || 0;
        mesh.userData = { zoneKey };
      }
    });
    return clone;
  }, [scene, material, zoneKey, renderOrder]);

  useEffect(() => {
    return () => {
      material.dispose();
    };
  }, [material]);

  return (
    <group ref={el => {
      if (el) meshesRef.current.set(`${zoneKey}_stick_group`, el);
      else meshesRef.current.delete(`${zoneKey}_stick_group`);
    }}>
      <primitive 
        object={clonedScene} 
        rotation={[Math.PI / 2, 0, 0]} 
        scale={[scale, scale, scale]} 
      />
    </group>
  );
}

useGLTF.preload('/joystick.glb');

export const SvgGamepadScene = forwardRef<SvgGamepadSceneHandle, Props>(
  ({ zones, input, theme, svgToWorldMatrix, viewportCenter, matcapTexture, outlineColor, isStandalone }, ref) => {
    const { camera, raycaster, size, scene } = useThree();
    const particlesRef  = useRef<Particle[]>([]);
    const lastTapRef    = useRef<Record<string, number>>({});
    const shakeGroupRef = useRef<THREE.Group>(null);
    const svgGroupRef   = useRef<THREE.Group>(null);
    const meshesRef     = useRef<Map<string, THREE.Object3D>>(new Map());
    const shakeRef      = useRef(0);
    const jsPosRef      = useRef<Record<string, { x: number; y: number }>>({});
    const tiltsRef      = useRef<Record<string, { x: number; y: number }>>({});

    const isMetallic = theme.metallic === true;

    // Pre-allocated objects for useFrame performance
    const _v1 = useMemo(() => new THREE.Vector3(), []);
    const _v2 = useMemo(() => new THREE.Vector3(), []);
    const _zero = useMemo(() => ({ x: 0, y: 0 }), []);

    // Set canvas background imperatively — <color attach="background"> only works at
    // scene root, not inside a <group>, so we must use scene.background directly.
    useEffect(() => {
      scene.background = new THREE.Color(theme.bg);
      return () => { scene.background = null; };
    }, [scene, theme.bg]);

    // Extract SVG→world scale and offset for joystick world-space positioning
    // (svgGroupRef matrix scales X/Y but not Z, so domes must live outside it)
    const svgMat = useMemo(() => ({
      sx: svgToWorldMatrix.elements[0],   // scaleX
      sy: svgToWorldMatrix.elements[5],   // scaleY (negative, Y-down→Y-up)
      tx: svgToWorldMatrix.elements[12],  // translateX
      ty: svgToWorldMatrix.elements[13],  // translateY
    }), [svgToWorldMatrix]);

    // Base tilt towards center
    const baseTilts = useMemo(() => {
      const map: Record<string, { x: number; y: number }> = {};
      if (!isStandalone && !viewportCenter) return map;

      zones.forEach(z => {
        let dx: number, dy: number;
        if (isStandalone) {
          dx = z.wx;
          dy = z.wy;
        } else {
          dx = z.svgExtra!.svgCx - viewportCenter!.x;
          dy = z.svgExtra!.svgCy - viewportCenter!.y;
        }
        
        const dist = Math.hypot(dx, dy);
        if (dist < 0.1) return;

        const amount = isStandalone ? 0.15 : 0.05;
        map[z.zoneKey] = {
          x: -(dy / dist) * amount,
          y:  (dx / dist) * amount,
        };
      });
      return map;
    }, [zones, viewportCenter, isStandalone]);

    // Apply SVG→world matrix to the inner group whenever it changes
    useLayoutEffect(() => {
      if (!svgGroupRef.current) return;
      svgGroupRef.current.matrix.copy(svgToWorldMatrix);
      svgGroupRef.current.matrixWorldNeedsUpdate = true;
    }, [svgToWorldMatrix]);

    // Parse geometries once per zone set; leave them in SVG coordinate space
    const geometries = useMemo(() => {
      const map = new Map<string, THREE.BufferGeometry | null>();
      for (const z of zones) {
        if (isStandalone) {
          // In standalone mode, we use standard shapes (Cylinder for buttons)
          // scaled to 1.0; we'll scale them by wRadius during rendering.
          const geo = new THREE.CylinderGeometry(1, 1, 0.4, 32);
          geo.rotateX(Math.PI / 2); // Make it face camera
          map.set(z.zoneKey, geo);
        } else {
          map.set(z.zoneKey, z.svgExtra?.pathD ? pathToGeometry(z.svgExtra.pathD) : null);
        }
      }
      return map;
    }, [zones, isStandalone]);

    useImperativeHandle(ref, () => ({
      triggerExplosion: (x, y, color, zoneId) => {
        const now   = Date.now();
        const prev  = lastTapRef.current[zoneId] ?? 0;
        const delta = now - prev;
        lastTapRef.current[zoneId] = now;
        const speed = Math.max(1, 400 / Math.max(50, delta));
        shakeRef.current = Math.min(5, shakeRef.current + 0.6 * Math.pow(speed, 0.033));
        for (let i = 0; i < 20; i++) {
          particlesRef.current.push({
            id: Math.random(),
            pos: new THREE.Vector3(x, y, 0.1),
            vel: new THREE.Vector3(
              (Math.random() - 0.5) * 15,
              (Math.random() - 0.5) * 15,
              Math.random() * 5,
            ),
            life: 1.0,
            color,
          });
        }
      },
      hitTest: (cx, cy) => {
        if (size.width === 0 || size.height === 0) return null;
        const mouse = new THREE.Vector2(
          (cx / size.width) * 2 - 1,
          -(cy / size.height) * 2 + 1
        );
        raycaster.setFromCamera(mouse, camera);
        const meshes = Array.from(meshesRef.current.values());
        const intersects = raycaster.intersectObjects(meshes, false);
        if (intersects.length > 0) {
          return intersects[0].object.userData.zoneKey || null;
        }
        return null;
      }
    }));

    useFrame((_, delta) => {
      const dt = Math.min(delta, 0.1);
      const isAnyPressed = zones.some(z => input.isPressed(z.zoneKey));

      if (shakeRef.current > 0 && isAnyPressed) {
        const s = shakeRef.current * 0.2;
        shakeGroupRef.current?.position.set(
          (Math.random() - 0.5) * s,
          (Math.random() - 0.5) * s,
          0,
        );
        shakeRef.current = Math.max(0, shakeRef.current - dt * 2);
      } else {
        shakeGroupRef.current?.position.set(0, 0, 0);
        if (!isAnyPressed && shakeRef.current > 0) shakeRef.current = 0;
      }

      particlesRef.current.forEach(p => {
        p.pos.addScaledVector(p.vel, dt);
        p.vel.multiplyScalar(0.92);
        p.life -= dt * 1.5;
      });
      particlesRef.current = particlesRef.current.filter(p => p.life > 0);

      // Smooth joystick offset and button tilts
      zones.forEach(z => {
        const isPressed = input.isPressed(z.zoneKey);
        const currentTilt = tiltsRef.current[z.zoneKey] ?? { x: 0, y: 0 };

        if (z.inputType === 'joystick') {
          const axis    = input.getAxis(z.zoneKey);
          const current = jsPosRef.current[z.zoneKey] ?? { x: 0, y: 0 };
          const r       = isStandalone ? z.wRadius : z.svgExtra!.svgRadius;
          
          let nx = 0, ny = 0;
          if (axis.x !== 0 || axis.y !== 0) {
            nx = current.x + ( axis.x * r - current.x) * 0.4;
            ny = current.y + (-axis.y * r - current.y) * 0.4;
          } else {
            nx = current.x * 0.8;
            ny = current.y * 0.8;
          }
          jsPosRef.current[z.zoneKey] = { x: nx, y: ny };

          // Imperative update of joystick model
          const wcx = isStandalone ? z.wx : z.svgExtra!.svgCx * svgMat.sx + svgMat.tx;
          const wcy = isStandalone ? z.wy : z.svgExtra!.svgCy * svgMat.sy + svgMat.ty;
          const dx  = (isStandalone ? nx : nx * svgMat.sx) * 1.203;
          const dy  = (isStandalone ? ny : ny * svgMat.sy) * 1.203;
          const dz  = isPressed ? -1 : 0;

          _v1.set(wcx + dx, wcy + dy, dz + 5);
          _v2.set(wcx, wcy, -3);
          
          const stickGroup = meshesRef.current.get(`${z.zoneKey}_stick_group`);
          if (stickGroup) {
            stickGroup.position.copy(_v2);
            stickGroup.lookAt(_v1);
            // Update intensity of all meshes inside stickGroup (head/stick)
            stickGroup.traverse(child => {
              if ((child as THREE.Mesh).isMesh) {
                const m = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
                if (m && m.emissive) m.emissiveIntensity = isPressed ? 2.5 : 0.5;
              }
            });
          }

          const baseMesh = meshesRef.current.get(`${z.zoneKey}_base`);
          if (baseMesh) {
            const mat = baseMesh.material as THREE.MeshStandardMaterial;
            if (mat && mat.emissive) mat.emissiveIntensity = isPressed ? 2.5 : 0.5;
          }
        } else {
          let tx = 0, ty = 0;
          if (isPressed) {
            const bx = baseTilts[z.zoneKey]?.x ?? 0;
            const by = baseTilts[z.zoneKey]?.y ?? 0;
            tx = currentTilt.x + (bx * 2 - currentTilt.x) * 0.4;
            ty = currentTilt.y + (by * 2 - currentTilt.y) * 0.4;
          } else {
            tx = currentTilt.x * 0.8;
            ty = currentTilt.y * 0.8;
          }
          tiltsRef.current[z.zoneKey] = { x: tx, y: ty };

          const mesh = meshesRef.current.get(z.zoneKey);
          if (mesh) {
            const bx = baseTilts[z.zoneKey]?.x ?? 0;
            const by = baseTilts[z.zoneKey]?.y ?? 0;
            mesh.rotation.set(bx + tx, by + ty, 0);
            mesh.position.z = isPressed ? -1 : 2;
            const mat = mesh.material as THREE.MeshStandardMaterial;
            if (mat && mat.emissive) mat.emissiveIntensity = isPressed ? 2.5 : 0.5;
          }
        }
      });
    });

    return (
      <group ref={shakeGroupRef}>
        <ambientLight intensity={0.5} />
        {/* Main light slightly offset to reveal extrusion relief */}
        <directionalLight position={[3, 4, 10]} intensity={2.0} />
        <directionalLight position={[-3, -4, 8]} intensity={0.6} />
        <pointLight position={[0, 0, 12]} intensity={0.8} color={theme.joystick} />

        <BackgroundPanel color={theme.bg} matcapTexture={matcapTexture} />

        {zones
          .filter(z => z.inputType === 'joystick')
          .map(z => {
            const isPressed = input.isPressed(z.zoneKey);
            const r         = z.wRadius;
            const rHead     = r * 0.85;
            const hHead     = rHead * 0.4;
            
            const wcx       = isStandalone ? z.wx : z.svgExtra!.svgCx * svgMat.sx + svgMat.tx;
            const wcy       = isStandalone ? z.wy : z.svgExtra!.svgCy * svgMat.sy + svgMat.ty;
            const basePos: [number, number, number] = [wcx, wcy, -3];

            const materialComp = matcapTexture ? (
              <meshMatcapMaterial key={matcapTexture.uuid} matcap={matcapTexture} side={THREE.DoubleSide} />
            ) : (
              <meshStandardMaterial
                key="standard"
                color={z.color}
                emissive={z.color}
                emissiveIntensity={isPressed ? 2.5 : 0.5}
                roughness={isMetallic ? 0.1 : 0.3}
                metalness={isMetallic ? 0.9 : 0.2}
                side={THREE.DoubleSide}
              />
            );

            return (
              <group key={z.zoneKey}>
                {/* 1. Base sphere (at neutral center, Z=-3) - "Le pied" */}
                <mesh 
                  position={basePos}
                  userData={{ zoneKey: z.zoneKey }}
                  renderOrder={10}
                  ref={el => {
                    if (el) meshesRef.current.set(`${z.zoneKey}_base`, el);
                    else meshesRef.current.delete(`${z.zoneKey}_base`);
                  }}
                >
                  <sphereGeometry args={[r, 32, 32]} />
                  {materialComp}
                </mesh>

                {/* 2. GLB Joystick (Stick + Head) */}
                <JoystickGLB 
                  scale={rHead}
                  matcapTexture={matcapTexture}
                  color={z.color}
                  isMetallic={isMetallic}
                  isPressed={isPressed}
                  zoneKey={z.zoneKey}
                  meshesRef={meshesRef}
                  renderOrder={15}
                />
              </group>
            );
          })}

        {/* Inner group with SVG→world matrix; non-joystick elements use SVG coordinates */}
        <group ref={svgGroupRef} matrixAutoUpdate={false}>
          {zones.map(z => {
            if (z.inputType === 'joystick') return null;

            const isPressed = input.isPressed(z.zoneKey);
            const baseTilt  = baseTilts[z.zoneKey] ?? { x: 0, y: 0 };
            const geo       = geometries.get(z.zoneKey);

            if (geo) {
              const posX = isStandalone ? z.wx : z.svgExtra!.svgCx;
              const posY = isStandalone ? z.wy : z.svgExtra!.svgCy;
              const posZ = isPressed ? -1 : 2;

              return (
                <mesh
                  key={z.zoneKey}
                  geometry={geo}
                  position={[posX, posY, posZ]}
                  scale={isStandalone ? [z.wRadius, z.wRadius, 1] : [1, 1, 1]}
                  rotation={[baseTilt.x, baseTilt.y, 0]}
                  userData={{ zoneKey: z.zoneKey }}
                  renderOrder={5}
                  ref={el => {
                    if (el) meshesRef.current.set(z.zoneKey, el);
                    else meshesRef.current.delete(z.zoneKey);
                  }}
                >
                  {matcapTexture
                    ? <meshMatcapMaterial key={matcapTexture.uuid} matcap={matcapTexture} side={THREE.DoubleSide} />
                    : (
                      <meshStandardMaterial
                        key="standard"
                        color={z.color}
                        emissive={z.color}
                        emissiveIntensity={isPressed ? 2.5 : 0.5}
                        roughness={isMetallic ? 0.1 : 0.3}
                        metalness={isMetallic ? 0.9 : 0.2}
                        side={THREE.DoubleSide}
                      />
                    )
                  }
                </mesh>
              );
            }

            // Fallback: single circle when no SVG path geometry is available
            const { svgCx, svgCy, svgRadius } = z.svgExtra || { svgCx: z.wx, svgCy: z.wy, svgRadius: z.wRadius };
            const posX = isStandalone ? z.wx : svgCx;
            const posY = isStandalone ? z.wy : svgCy;
            const radius = isStandalone ? z.wRadius : svgRadius * 0.88;

            return (
              <mesh
                key={z.zoneKey}
                position={[posX, posY, isPressed ? -2 : 2.5]}
                rotation={[baseTilt.x, baseTilt.y, 0]}
                userData={{ zoneKey: z.zoneKey }}
                renderOrder={5}
                ref={el => {
                  if (el) meshesRef.current.set(z.zoneKey, el);
                  else meshesRef.current.delete(z.zoneKey);
                }}
              >
                <circleGeometry args={[radius, 48]} />
                {matcapTexture
                  ? <meshMatcapMaterial key={matcapTexture.uuid} matcap={matcapTexture} />
                  : (
                    <meshStandardMaterial
                      key="standard"
                      color={z.color}
                      emissive={z.color}
                      emissiveIntensity={isPressed ? 6.0 : 1.2}
                      roughness={isMetallic ? 0.1 : 0.3}
                      metalness={isMetallic ? 0.9 : 0.2}
                    />
                  )
                }
              </mesh>
            );
          })}
        </group>

        <ParticlesInstances particles={particlesRef.current} />

        <OutlineEffect meshesRef={meshesRef} outlineColor={outlineColor} />
      </group>
    );
  },
);

function ParticlesInstances({ particles }: { particles: Particle[] }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy   = useMemo(() => new THREE.Object3D(), []);
  const color   = useMemo(() => new THREE.Color(), []);

  useFrame(() => {
    if (!meshRef.current) return;
    const count = Math.min(particles.length, 1000);
    for (let i = 0; i < count; i++) {
      const p = particles[i];
      dummy.position.copy(p.pos);
      const s = p.life * 0.12;
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);
      color.set(p.color);
      meshRef.current.setColorAt!(i, color);
    }
    meshRef.current.count = count;
    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, 1000]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial />
    </instancedMesh>
  );
}
