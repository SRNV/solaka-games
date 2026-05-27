import { useState, useLayoutEffect, useCallback, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import gsap from 'gsap';

/**
 * HitAnimService — Un service pour déclencher des animations d'impact complexes
 * composées de multiples couches d'images avec des timings et effets variés.
 */

export interface HitLayerDef {
  url: string;
  delay: number;      // délai avant apparition (ms)
  duration: number;   // durée totale (ms)
  scale: [number, number]; // [start, end]
  opacity: [number, number]; // [start, end]
  rotation?: number | 'random';
  blendMode?: THREE.Blending;
  renderOrder?: number;
}

export interface HitSequenceDef {
  layers: HitLayerDef[];
}

// --- Singleton Service ---

type PlayFn = (sequence: HitSequenceDef, x: number, y: number, z: number) => void;
let _play: PlayFn = () => {};

export const HitAnimService = {
  play(sequence: HitSequenceDef, x: number, y: number, z: number) {
    _play(sequence, x, y, z);
  }
};

// --- Internal Component ---

interface HitInstance {
  id: number;
  sequence: HitSequenceDef;
  pos: [number, number, number];
}

let _nextId = 0;

function HitLayer({ layer, pos, onDone }: { layer: HitLayerDef, pos: [number, number, number], onDone: () => void }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const texture = useRef<THREE.Texture | null>(null);
  
  useFrame(({ camera }) => {
    if (meshRef.current) {
      meshRef.current.quaternion.copy(camera.quaternion);
      const rotation = layer.rotation === 'random' ? (meshRef.current.userData.randomRot ?? 0) : (layer.rotation ?? 0);
      if (rotation !== 0) {
        meshRef.current.rotateZ(rotation);
      }
    }
  });

  useLayoutEffect(() => {
    texture.current = new THREE.TextureLoader().load(layer.url);
    texture.current.colorSpace = THREE.SRGBColorSpace;
    
    const mesh = meshRef.current;
    if (!mesh) return;

    if (layer.rotation === 'random') {
      mesh.userData.randomRot = Math.random() * Math.PI * 2;
    }

    const startScale = layer.scale[0];
    const endScale = layer.scale[1];
    const startOpacity = layer.opacity[0];
    const endOpacity = layer.opacity[1];
    const rotation = layer.rotation === 'random' ? Math.random() * Math.PI * 2 : (layer.rotation ?? 0);

    mesh.scale.setScalar(startScale);
    mesh.rotation.z = rotation;
    (mesh.material as THREE.MeshBasicMaterial).opacity = startOpacity;

    const tl = gsap.timeline({ 
      delay: layer.delay / 1000,
      onComplete: onDone 
    });

    tl.to(mesh.scale, {
      x: endScale,
      y: endScale,
      z: endScale,
      duration: layer.duration / 1000,
      ease: 'power2.out'
    }, 0);

    tl.to(mesh.material, {
      opacity: endOpacity,
      duration: layer.duration / 1000,
      ease: 'power2.inOut'
    }, 0);

    return () => {
      tl.kill();
      texture.current?.dispose();
    };
  }, []);

  return (
    <mesh ref={meshRef} position={pos} renderOrder={layer.renderOrder ?? 1000}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial 
        map={texture.current}
        transparent 
        depthWrite={false}
        blending={layer.blendMode ?? THREE.AdditiveBlending}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function HitSequence({ inst, onDone }: { inst: HitInstance, onDone: (id: number) => void }) {
  const [completedLayers, setCompletedLayers] = useState(0);

  const handleLayerDone = useCallback(() => {
    setCompletedLayers(prev => {
      const next = prev + 1;
      if (next >= inst.sequence.layers.length) {
        onDone(inst.id);
      }
      return next;
    });
  }, [inst, onDone]);

  return (
    <group>
      {inst.sequence.layers.map((layer, i) => (
        <HitLayer 
          key={i} 
          layer={layer} 
          pos={inst.pos} 
          onDone={handleLayerDone} 
        />
      ))}
    </group>
  );
}

// --- Main Layer Provider ---

export function HitAnimLayer() {
  const [instances, setInstances] = useState<HitInstance[]>([]);

  useLayoutEffect(() => {
    _play = (sequence, x, y, z) => {
      setInstances(prev => [...prev, { 
        id: _nextId++, 
        sequence, 
        pos: [x, y, z] 
      }]);
    };
    return () => { _play = () => {}; };
  }, []);

  const remove = useCallback((id: number) => {
    setInstances(prev => prev.filter(inst => inst.id !== id));
  }, []);

  return (
    <>
      {instances.map(inst => (
        <HitSequence key={inst.id} inst={inst} onDone={remove} />
      ))}
    </>
  );
}
