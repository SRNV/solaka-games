import { Gamepad3D } from '../../components/Gamepad3D.tsx';
import type { GamepadProps } from '../../components/Gamepad.tsx';
import type { InputDescriptor } from '../../types/inputs.ts';

// Only MetelController and Metel know these IDs — generic infrastructure stays agnostic.
const METEL_INPUTS: InputDescriptor[] = [
  { type: 'axis2d', id: 'move',  slot: 'left'           },
  { type: 'button', id: 'a',     label: 'A', slot: 'diamond-right'  },
  { type: 'button', id: 'b',     label: 'B', slot: 'diamond-bottom' },
  { type: 'button', id: 'x',     label: 'X', slot: 'diamond-left'   },
  { type: 'button',  id: 'y',     label: 'Y',     slot: 'diamond-top'    },
  { type: 'boolean', id: 'start', label: 'START', slot: 'center'         },
];

export default function MetelController({ roomId, controllerId }: GamepadProps) {
  return <Gamepad3D roomId={roomId} controllerId={controllerId} inputs={METEL_INPUTS} />;
}
