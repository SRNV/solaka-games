import { useRef, useMemo, useState, forwardRef, useImperativeHandle } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Zone } from './useZones.ts';
import type { GamepadTheme } from './themes.ts';

interface Particle {
  id: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  color: string;
}

export interface GamepadSceneHandle {
  triggerExplosion: (x: number, y: number, color: string, zoneId: string) => void;
}

export const GamepadScene = forwardRef<GamepadSceneHandle, { zones: Zone[]; input: any, theme: GamepadTheme }>(
  ({ zones, input, theme }, ref) => {
    const particlesRef = useRef<Particle[]>([]);
    const lastTapRef = useRef<Record<string, number>>({});
    const lastExplosionTimeRef = useRef<number>(0);
    const lastUpTimeRef = useRef<number>(0);
    const groupRef = useRef<THREE.Group>(null);
    const [shake, setShake] = useState(0);

    // Joystick state for 3D visu
    const [jsPos, setJsPos] = useState<Record<string, { x: number; y: number }>>({});

    useImperativeHandle(ref, () => ({
      triggerExplosion: (x, y, color, zoneId) => {
        const now = Date.now();
        
        // Debounce: prevent adding shake too frequently (e.g. 5ms window)
        const isDebounced = now - lastExplosionTimeRef.current < 5;
        
        const prev = lastTapRef.current[zoneId] || 0;
        const delta = now - prev;
        lastTapRef.current[zoneId] = now;

        if (!isDebounced) {
          lastExplosionTimeRef.current = now;
          // Proportional shake: faster taps = stronger shake (x^0.033 power law)
          const speed = Math.max(1, 400 / Math.max(50, delta));
          const boost = Math.pow(speed, 0.033);
          setShake(s => Math.min(5, s + 0.6 * boost));
        }

        // Old particles logic: simple points
        for (let i = 0; i < 20; i++) {
          particlesRef.current.push({
            id: Math.random(),
            pos: new THREE.Vector3(x, y, 0.1),
            vel: new THREE.Vector3(
              (Math.random() - 0.5) * 15, 
              (Math.random() - 0.5) * 15, 
              Math.random() * 5
            ),
            life: 1.0,
            color
          });
        }
      }
    }));

    useFrame((state, delta) => {
      const dt = Math.min(delta, 0.1);
      const now = Date.now();

      // Check if any button is currently pressed
      const isAnyPressed = zones.some(z => input.isPressed(z.id));
      
      if (isAnyPressed) {
        lastUpTimeRef.current = 0;
      } else if (lastUpTimeRef.current === 0) {
        lastUpTimeRef.current = now;
      }

      // Should we continue shaking? (Pressed OR within 5ms of last release)
      const shouldKeepShake = isAnyPressed || (lastUpTimeRef.current !== 0 && (now - lastUpTimeRef.current < 5));

      // 1. Scene Shake
      if (shake > 0 && shouldKeepShake) {
        const s = shake * 0.2;
        groupRef.current?.position.set(
          (Math.random() - 0.5) * s,
          (Math.random() - 0.5) * s,
          0
        );
        
        // Slow decay while shaking is "active" to keep it dynamic
        setShake(prev => Math.max(0, prev - dt * 2));
      } else {
        groupRef.current?.position.set(0, 0, 0);
        // If we stop shaking because of release, clear the shake value
        if (!shouldKeepShake && shake > 0) setShake(0);
      }

      // 2. Particles update
      particlesRef.current.forEach(p => {
        p.pos.addScaledVector(p.vel, dt);
        p.vel.multiplyScalar(0.92);
        p.life -= dt * 1.5;
      });
      particlesRef.current = particlesRef.current.filter(p => p.life > 0);

      // 3. Joystick lerp
      const newJsPos: Record<string, { x: number; y: number }> = {};
      zones.filter(z => z.inputType === 'joystick').forEach(z => {
        const axis = input.getAxis(z.id);
        if (axis.x !== 0 || axis.y !== 0) {
          const targetX = axis.x * z.wRadius;
          const targetY = axis.y * z.wRadius;
          const current = jsPos[z.id] || { x: 0, y: 0 };
          newJsPos[z.id] = {
            x: current.x + (targetX - current.x) * 0.4,
            y: current.y + (targetY - current.y) * 0.4
          };
        } else {
          const current = jsPos[z.id] || { x: 0, y: 0 };
          newJsPos[z.id] = {
            x: current.x * 0.8,
            y: current.y * 0.8
          };
        }
      });
      setJsPos(newJsPos);
    });

    return (
      <group ref={groupRef}>
        <ambientLight intensity={1.2} />
        <pointLight position={[0, 0, 10]} intensity={2.2} color={theme.joystick} />
        <pointLight position={[5, 5, 5]} intensity={0.8} color="#ffffff" />
        
        {zones.map(z => {
          const isPressed = input.isPressed(z.id);
          const p = jsPos[z.id] || { x: 0, y: 0 };
          
          return (
            <group key={z.id} position={[z.wx, z.wy, 0]}>
              {/* Outer Ring */}
              <mesh>
                <ringGeometry args={[z.wRadius * 0.92, z.wRadius, 48]} />
                <meshStandardMaterial 
                  color={z.color} 
                  emissive={z.color} 
                  emissiveIntensity={isPressed ? 3.0 : 0.8} 
                  transparent 
                  opacity={0.8}
                />
              </mesh>

              {/* Glowing Background Glow */}
              <mesh position={[0, 0, -0.1]}>
                <circleGeometry args={[z.wRadius, 48]} />
                <meshBasicMaterial 
                  color={z.color}
                  transparent
                  opacity={isPressed ? 0.3 : 0.1}
                />
              </mesh>

              {/* Main Button / Joystick Knob */}
              <mesh position={[p.x, p.y, isPressed ? -0.15 : 0.2]}>
                <circleGeometry args={[z.wRadius * (z.inputType === 'joystick' ? 0.68 : 0.88), 48]} />
                <meshStandardMaterial 
                  color={z.color} 
                  emissive={z.color}
                  emissiveIntensity={isPressed ? 6.0 : 1.2}
                />
              </mesh>
            </group>
          );
        })}

        <ParticlesInstances particles={particlesRef.current} />
      </group>
    );
  }
);

function ParticlesInstances({ particles }: { particles: Particle[] }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame(() => {
    if (!meshRef.current) return;
    particles.forEach((p, i) => {
      dummy.position.copy(p.pos);
      const s = p.life * 0.12;
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      meshRef.current!.setMatrixAt(i, dummy.matrix);
      meshRef.current!.setColorAt(i, new THREE.Color(p.color));
    });
    meshRef.current.count = particles.length;
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
