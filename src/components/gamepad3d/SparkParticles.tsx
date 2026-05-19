import { useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const MAX_PARTICLES = 2000;

const vertexShader = `
  attribute float life;
  attribute vec3 velocity;
  attribute float startTime;
  attribute vec3 color;

  uniform float uTime;
  uniform float uGravity;

  varying float vLife;
  varying vec3 vColor;

  void main() {
    float age = uTime - startTime;
    vLife = 1.0 - (age / 1.0); // 1.0s lifespan
    vColor = color;

    if (vLife <= 0.0) {
      gl_Position = vec4(100.0, 100.0, 100.0, 1.0); // Hide dead particles
      return;
    }

    // Physics: Pos = V0*t + 0.5*g*t^2
    vec3 currentPos = instanceMatrix[3].xyz + (velocity * age) + vec3(0.0, 0.5 * uGravity * age * age, 0.0);

    // Realistic stretch: align with velocity
    vec3 vel = velocity + vec3(0.0, uGravity * age, 0.0);
    float speed = length(vel);
    
    // Simple stretching logic for a "spark" look
    vec3 localPos = position;
    localPos.y *= (1.0 + speed * 0.3); // More stretch

    // Increased size factor from 0.1 to 0.4
    vec4 mvPosition = modelViewMatrix * vec4(currentPos + localPos * vLife * 0.4, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = `
  varying float vLife;
  varying vec3 vColor;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    // Brighter glow effect
    float strength = 0.15 / (d + 0.05);
    
    // Boosted emission (4.0 instead of 2.0)
    gl_FragColor = vec4(vColor * strength * 4.0, vLife);
  }
`;

export interface SparkParticlesHandle {
  spawn: (x: number, y: number, color: string, count: number) => void;
}

export const SparkParticles = forwardRef<SparkParticlesHandle>((_, ref) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const nextIdxRef = useRef(0);

  // Buffer attributes
  const velocity = useMemo(() => new Float32Array(MAX_PARTICLES * 3), []);
  const startTime = useMemo(() => new Float32Array(MAX_PARTICLES), []);
  const colors = useMemo(() => new Float32Array(MAX_PARTICLES * 3), []);

  useImperativeHandle(ref, () => ({
    spawn: (x, y, colorStr, count) => {
      if (!meshRef.current) return;
      const c = new THREE.Color(colorStr);
      const dummy = new THREE.Object3D();
      const now = performance.now() / 1000;

      for (let i = 0; i < count; i++) {
        const idx = nextIdxRef.current;
        
        // Initial position
        dummy.position.set(x, y, 0.1);
        dummy.updateMatrix();
        meshRef.current.setMatrixAt(idx, dummy.matrix);

        // Velocity (Explosion)
        const angle = Math.random() * Math.PI * 2;
        const force = 5 + Math.random() * 15;
        velocity[idx * 3 + 0] = Math.cos(angle) * force;
        velocity[idx * 3 + 1] = Math.sin(angle) * force;
        velocity[idx * 3 + 2] = (Math.random() - 0.5) * 5;

        startTime[idx] = now;
        colors[idx * 3 + 0] = c.r;
        colors[idx * 3 + 1] = c.g;
        colors[idx * 3 + 2] = c.b;

        nextIdxRef.current = (idx + 1) % MAX_PARTICLES;
      }
      meshRef.current.instanceMatrix.needsUpdate = true;
      meshRef.current.geometry.attributes.velocity.needsUpdate = true;
      meshRef.current.geometry.attributes.startTime.needsUpdate = true;
      meshRef.current.geometry.attributes.color.needsUpdate = true;
    }
  }));

  useFrame(({ clock }) => {
    if (meshRef.current) {
      (meshRef.current.material as THREE.ShaderMaterial).uniforms.uTime.value = clock.elapsedTime;
    }
  });

  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uGravity: { value: -30.0 }
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  }), []);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, MAX_PARTICLES]}>
      <circleGeometry args={[1, 8]}>
        <instancedBufferAttribute attach="attributes-velocity" args={[velocity, 3]} />
        <instancedBufferAttribute attach="attributes-startTime" args={[startTime, 1]} />
        <instancedBufferAttribute attach="attributes-color" args={[colors, 3]} />
      </circleGeometry>
      <primitive object={material} attach="material" />
    </instancedMesh>
  );
});
