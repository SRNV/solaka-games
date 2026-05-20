import { lazy, LazyExoticComponent, ComponentType } from 'react';
import type { GamepadProps } from '../Gamepad.tsx';

export interface ConsoleProps {
  roomId: string;
  slug: string;
}

export type ConsoleComponent = LazyExoticComponent<ComponentType<ConsoleProps>>;
export type ControllerComponent = LazyExoticComponent<ComponentType<GamepadProps>>;

export interface GameEntry {
  console: ConsoleComponent;
  controller: ControllerComponent;
}

export const GAME_REGISTRY: Record<string, GameEntry> = {
  'metel': {
    console:    lazy(() => import('../../lib/metel/Metel.tsx')),
    controller: lazy(() => import('../../lib/metel/MetelController.tsx')),
  },
  'metel-game': {
    console:    lazy(() => import('../../lib/metel/Metel.tsx')),
    controller: lazy(() => import('../../lib/metel/MetelController.tsx')),
  },
};
