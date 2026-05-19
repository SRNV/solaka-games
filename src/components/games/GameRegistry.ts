import { lazy, LazyExoticComponent, ComponentType } from 'react';
import type { GamepadProps } from '../Gamepad.tsx';

export type GameComponent = LazyExoticComponent<ComponentType<any>>;
export type ControllerComponent = LazyExoticComponent<ComponentType<GamepadProps>>;

export interface GameEntry {
  console: GameComponent;
  controller: ControllerComponent;
}

export const GAME_REGISTRY: Record<string, GameEntry> = {
  'metel-game': {
    console:    lazy(() => import('../../lib/metel/Metel.tsx')),
    controller: lazy(() => import('../../lib/metel/MetelController.tsx')),
  },
};
