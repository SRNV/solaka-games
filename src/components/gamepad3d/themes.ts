export interface GamepadTheme {
  id: string;
  name: string;
  bg: string;
  joystick: string;
  btnA: string;    // diamond-right
  btnB: string;    // diamond-bottom
  btnXY: string;   // diamond-top / diamond-left
  btnCenter: string;
}

export const THEMES: GamepadTheme[] = [
  {
    id: 'default',
    name: 'Classique',
    bg: '#0a0a0a',
    joystick:   '#C879FF',
    btnA:       '#C879FF',
    btnB:       '#D4AC0D',
    btnXY:      '#9A9A9A',
    btnCenter:  '#777777',
  },
  {
    id: 'neon',
    name: 'Néon',
    bg: '#050510',
    joystick:   '#3BF4FB',
    btnA:       '#3BF4FB',
    btnB:       '#CAFF8A',
    btnXY:      '#FF6BB5',
    btnCenter:  '#7B7B9A',
  },
  {
    id: 'fire',
    name: 'Feu',
    bg: '#0a0503',
    joystick:   '#FF6B35',
    btnA:       '#FF6B35',
    btnB:       '#FFD700',
    btnXY:      '#CC4400',
    btnCenter:  '#886633',
  },
  {
    id: 'ice',
    name: 'Glace',
    bg: '#030a12',
    joystick:   '#4FC3F7',
    btnA:       '#4FC3F7',
    btnB:       '#E1F5FE',
    btnXY:      '#1A6B8A',
    btnCenter:  '#2A4A5A',
  },
];

export const DEFAULT_THEME = THEMES[0];

export function findTheme(id: string): GamepadTheme {
  return THEMES.find(t => t.id === id) ?? DEFAULT_THEME;
}
