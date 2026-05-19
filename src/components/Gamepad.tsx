import { useCallback, useRef } from 'react';
import { getGamesStompClient } from '../gamesStompClient.ts';
import styles from './Gamepad.module.css';

export interface GamepadProps {
  roomId: string;
  controllerId: string;
  active?: boolean;
}

type ButtonId = 'a' | 'b' | 'x' | 'y';

export function Gamepad({ roomId, controllerId }: GamepadProps) {
  // Maps pointerId → which button it's pressing
  const pointerBtn = useRef<Map<number, ButtonId>>(new Map());
  const joystick = useRef({ x: 0, y: 0 });
  const jsPointer = useRef<number | null>(null);
  const baseRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  const publish = useCallback(() => {
    const client = getGamesStompClient();
    if (!client.connected) return;
    client.publish({
      destination: `/topic/room/${roomId}/input`,
      body: JSON.stringify({
        controllerId,
        joystick: joystick.current,
        buttons: Array.from(new Set(pointerBtn.current.values())),
      }),
    });
  }, [roomId, controllerId]);

  // ── Joystick ────────────────────────────────────────────
  function moveJoystick(clientX: number, clientY: number) {
    const base = baseRef.current;
    const thumb = thumbRef.current;
    if (!base || !thumb) return;
    const r = base.getBoundingClientRect();
    const dx = clientX - (r.left + r.width / 2);
    const dy = clientY - (r.top + r.height / 2);
    const dist = Math.hypot(dx, dy);
    const maxTravel = r.width * 0.3;
    const clamp = Math.min(dist, maxTravel);
    const angle = Math.atan2(dy, dx);
    const tx = Math.cos(angle) * clamp;
    const ty = Math.sin(angle) * clamp;
    thumb.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px))`;
    joystick.current = {
      x: dist > 8 ? Math.round((dx / dist) * (clamp / maxTravel) * 100) / 100 : 0,
      y: dist > 8 ? Math.round((dy / dist) * (clamp / maxTravel) * 100) / 100 : 0,
    };
    publish();
  }

  function jsDown(e: React.PointerEvent) {
    if (jsPointer.current !== null) return;
    jsPointer.current = e.pointerId;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    moveJoystick(e.clientX, e.clientY);
  }
  function jsMove(e: React.PointerEvent) {
    if (e.pointerId !== jsPointer.current) return;
    moveJoystick(e.clientX, e.clientY);
  }
  function jsUp(e: React.PointerEvent) {
    if (e.pointerId !== jsPointer.current) return;
    jsPointer.current = null;
    if (thumbRef.current) thumbRef.current.style.transform = 'translate(-50%, -50%)';
    joystick.current = { x: 0, y: 0 };
    publish();
  }

  // ── Action buttons ───────────────────────────────────────
  // Using div instead of button: Safari blocks simultaneous touches on <button>
  function btnDown(e: React.PointerEvent, id: ButtonId) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointerBtn.current.set(e.pointerId, id);
    publish();
  }
  function btnUp(e: React.PointerEvent) {
    pointerBtn.current.delete(e.pointerId);
    publish();
  }

  function btnProps(id: ButtonId) {
    return {
      role: 'button' as const,
      onPointerDown: (e: React.PointerEvent) => btnDown(e, id),
      onPointerUp:   btnUp,
      onPointerCancel: btnUp,
    };
  }

  return (
    <div className={styles.pad}>
      {/* Joystick */}
      <div className={styles.joystickZone}>
        <div
          ref={baseRef}
          className={styles.joystickBase}
          onPointerDown={jsDown}
          onPointerMove={jsMove}
          onPointerUp={jsUp}
          onPointerCancel={jsUp}
        >
          <div ref={thumbRef} className={styles.joystickThumb} />
        </div>
      </div>

      {/* Action buttons */}
      <div className={styles.actions}>
        <div className={styles.actionRow}>
          <div {...btnProps('y')} className={`${styles.actionBtn} ${styles.btnY}`}>Y</div>
        </div>
        <div className={styles.actionRow}>
          <div {...btnProps('x')} className={`${styles.actionBtn} ${styles.btnX}`}>X</div>
          <div className={styles.actionGap} />
          <div {...btnProps('a')} className={`${styles.actionBtn} ${styles.btnA}`}>A</div>
        </div>
        <div className={styles.actionRow}>
          <div {...btnProps('b')} className={`${styles.actionBtn} ${styles.btnB}`}>B</div>
        </div>
      </div>
    </div>
  );
}
