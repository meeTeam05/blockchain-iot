import { AtmosphereTokens } from './tokens';

export interface AtmospherePaletteBase {
  brand: string;
  brandDeep: string;
  brandTint: string;
  brandTint2: string;
  accent: string;
  accentTint: string;
  warn: string;
  warnTint: string;
  danger: string;
  dangerTint: string;
  amber: string;
  mint: string;
  ink: string;
  ink2: string;
  ink3: string;
  line: string;
  line2: string;
  bg: string;
  paper: string;
  tileCoolA: string;
  tileWarmA: string;
  tileAirA: string;
  tileNo2A: string;
}

export type AtmospherePalette = AtmospherePaletteBase & {
  textPrimary: string;
  textSecondary: string;
  surface: string;
  surfaceVar: string;
  border: string;
};

function derive(base: AtmospherePaletteBase): AtmospherePalette {
  return {
    ...base,
    textPrimary: base.ink,
    textSecondary: base.ink3,
    surface: base.paper,
    surfaceVar: base.line2,
    border: base.line,
  };
}

export const lightPalette: AtmospherePalette = derive({
  brand: AtmosphereTokens.brand,
  brandDeep: AtmosphereTokens.brandDeep,
  brandTint: AtmosphereTokens.brandTint,
  brandTint2: AtmosphereTokens.brandTint2,
  accent: AtmosphereTokens.accent,
  accentTint: AtmosphereTokens.accentTint,
  warn: AtmosphereTokens.warn,
  warnTint: AtmosphereTokens.warnTint,
  danger: AtmosphereTokens.danger,
  dangerTint: AtmosphereTokens.dangerTint,
  amber: AtmosphereTokens.amber,
  mint: AtmosphereTokens.mint,
  ink: AtmosphereTokens.ink,
  ink2: AtmosphereTokens.ink2,
  ink3: AtmosphereTokens.ink3,
  line: AtmosphereTokens.line,
  line2: AtmosphereTokens.line2,
  bg: AtmosphereTokens.bg,
  paper: AtmosphereTokens.paper,
  tileCoolA: AtmosphereTokens.tileCoolA,
  tileWarmA: AtmosphereTokens.tileWarmA,
  tileAirA: AtmosphereTokens.tileAirA,
  tileNo2A: AtmosphereTokens.tileNo2A,
});

export const darkPalette: AtmospherePalette = derive({
  brand: AtmosphereTokens.brand,
  brandDeep: AtmosphereTokens.brandDeep,
  brandTint: '#143C36',
  brandTint2: '#1B5048',
  accent: AtmosphereTokens.accent,
  accentTint: '#152643',
  warn: AtmosphereTokens.warn,
  warnTint: '#3A2410',
  danger: AtmosphereTokens.danger,
  dangerTint: '#3A1612',
  amber: AtmosphereTokens.amber,
  mint: AtmosphereTokens.mint,
  ink: '#E8EEEC',
  ink2: '#B6C5C0',
  ink3: '#8A9994',
  line: '#1F2A26',
  line2: '#17211E',
  bg: '#0B1411',
  paper: '#12201C',
  tileCoolA: '#143C36',
  tileWarmA: '#3A2410',
  tileAirA: '#152643',
  tileNo2A: '#231538',
});

export function paletteFor(colorScheme: 'light' | 'dark'): AtmospherePalette {
  return colorScheme === 'dark' ? darkPalette : lightPalette;
}
