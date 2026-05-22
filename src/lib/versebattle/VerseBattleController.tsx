import { Gamepad3D } from '../../components/Gamepad3D.tsx';
import type { GamepadProps } from '../../components/Gamepad.tsx';

export default function VerseBattleController({ roomId, controllerId, active, isMaster, onReconnect }: GamepadProps) {
  return (
    <Gamepad3D
      roomId={roomId}
      controllerId={controllerId}
      active={active}
      isMaster={isMaster}
      onReconnect={onReconnect}
      svgUrl="/manette_2.svg"
    />
  );
}
