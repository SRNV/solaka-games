export interface GamepadTheme {
  id: string;
  name: string;
  bg: string;
  joystick: string;
  btnA: string;    // diamond-right
  btnB: string;    // diamond-bottom
  btnXY: string;   // diamond-top / diamond-left
  btnCenter: string;
  /** Enables metallic material (roughness 0.1, metalness 0.9) */
  metallic?: boolean;
  /** Color of the post-process outline for this theme */
  outlineColor: string;
}

export const THEMES: GamepadTheme[] = [
  {
    id: 'default',
    name: 'Classique',
    bg: '#0a0a0a',
    joystick:     '#C879FF',
    btnA:         '#C879FF',
    btnB:         '#D4AC0D',
    btnXY:        '#9A9A9A',
    btnCenter:    '#777777',
    outlineColor: '#C879FF',
  },
  {
    id: 'neon',
    name: 'Néon',
    bg: '#050510',
    joystick:     '#3BF4FB',
    btnA:         '#3BF4FB',
    btnB:         '#CAFF8A',
    btnXY:        '#FF6BB5',
    btnCenter:    '#7B7B9A',
    outlineColor: '#3BF4FB',
  },
  {
    id: 'fire',
    name: 'Feu',
    bg: '#0a0503',
    joystick:     '#FF6B35',
    btnA:         '#FF6B35',
    btnB:         '#FFD700',
    btnXY:        '#CC4400',
    btnCenter:    '#886633',
    outlineColor: '#FFD700',
  },
  {
    id: 'ice',
    name: 'Glace',
    bg: '#030a12',
    joystick:     '#4FC3F7',
    btnA:         '#4FC3F7',
    btnB:         '#E1F5FE',
    btnXY:        '#1A6B8A',
    btnCenter:    '#2A4A5A',
    outlineColor: '#4FC3F7',
  },
  {
    id: 'metallic',
    name: 'Métallique',
    bg: '#1a1a1a',
    joystick:     '#a0a0a0',
    btnA:         '#b0b0b0',
    btnB:         '#909090',
    btnXY:        '#808080',
    btnCenter:    '#707070',
    metallic:     true,
    outlineColor: '#c8c8c8',
  },
  {
    id: 'chrome',
    name: 'Chrome',
    bg: '#07080f',
    joystick:     '#D8E4F0',
    btnA:         '#EEF2FF',
    btnB:         '#9AAEC8',
    btnXY:        '#BCC8D8',
    btnCenter:    '#7888A0',
    metallic:     true,
    outlineColor: '#D8E4F0',
  },
  {
    id: 'silver',
    name: 'Argent',
    bg: '#0a0a10',
    joystick:     '#D4CCBC',
    btnA:         '#E8E0D0',
    btnB:         '#A8A090',
    btnXY:        '#C4BCB0',
    btnCenter:    '#888078',
    metallic:     true,
    outlineColor: '#E8E0D0',
  },
  {
    id: 'bronze',
    name: 'Bronze',
    bg: '#0d0803',
    joystick:     '#CD7F32',
    btnA:         '#D8924A',
    btnB:         '#9A5818',
    btnXY:        '#B47030',
    btnCenter:    '#7A4820',
    metallic:     true,
    outlineColor: '#CD7F32',
  },
];

export const DEFAULT_THEME = THEMES[0];

export function findTheme(id: string): GamepadTheme {
  return THEMES.find(t => t.id === id) ?? DEFAULT_THEME;
}
