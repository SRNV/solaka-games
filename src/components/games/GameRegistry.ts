import { lazy, LazyExoticComponent, ComponentType } from 'react';

// Type pour nos composants de jeux
export type GameComponent = LazyExoticComponent<ComponentType<any>>;

// Le Registry mappe les slugs du serveur aux imports dynamiques
// Note: Les chemins sont relatifs à l'emplacement de ce fichier dans le submodule
export const GAME_REGISTRY: Record<string, GameComponent> = {
  'metel-game': lazy(() => import('../../lib/metel/Metel.tsx')),
};
