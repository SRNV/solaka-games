import { Shader, LinearGradient, FilmGrain, ChromaticAberration, Blur, Stripes, ImageTexture, CursorTrail, CursorRipples, Shatter, Bulge, Plasma } from 'shaders/react';
import type { GamepadTheme } from './themes.ts';

interface GamepadBackgroundProps {
  theme: GamepadTheme;
  joystick: { x: number; y: number };
  isPressed: boolean;
}

export function GamepadBackground({ theme, isPressed }: GamepadBackgroundProps) {
  // Angle is now fixed as requested
  const angle = 25;

  return (
    <Shader 
      style={{ 
        position: 'absolute', 
        inset: 0, 
        width: '100%', 
        height: '100%', 
        zIndex: 0,
        pointerEvents: 'none' 
      }}
    >
      {/* 1. Base Gradient - Deep Dark */}
      <LinearGradient 
        colorA="#050505" 
        colorB="#121212" 
        angle={angle} 
      />

      {/* 4. Second Color Accent (Dynamic depth) */}
      <LinearGradient 
        colorA={theme.joystick}
        colorB="transparent"
        angle={180}
        opacity={0.1}
      />
      <ChromaticAberration></ChromaticAberration>
      {/* 4. Second Color Accent (Dynamic depth) */}
      <LinearGradient 
        colorA={theme.joystick}
        colorB="transparent"
        angle={angle + 180}
        opacity={0.1}
      />

      <Shatter></Shatter>


<CursorRipples></CursorRipples>

    </Shader>
  );
}
