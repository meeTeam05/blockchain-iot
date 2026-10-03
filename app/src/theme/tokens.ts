/**
 * Atmosphere brand tokens. Source: app/lib/design/tokens.dart.
 * These are the only raw color/spacing literals allowed in the codebase —
 * everything else must consume via theme/palette.ts.
 */
export const AtmosphereTokens = {
  // Brand
  brand: '#0F6B5C',
  brandDeep: '#0A4F44',
  brandTint: '#E4F0EC',
  brandTint2: '#D5E8E1',

  // Secondary
  accent: '#2C6BF0',
  accentTint: '#E5EEFD',

  // Semantic
  warn: '#E07A1A',
  warnTint: '#FFF1DF',
  danger: '#D9462E',
  dangerTint: '#FFE5E0',
  amber: '#E8A33C',
  mint: '#BFE6D8',

  // Neutrals (light theme defaults; dark overrides live in palette.ts)
  ink: '#0E1F1B',
  ink2: '#3F5751',
  ink3: '#6E827D',
  line: '#E3EAE7',
  line2: '#EEF3F1',
  bg: '#F5F7F6',
  paper: '#FFFFFF',

  // Tile gradients (sensor cards), 2-stop
  tileCoolA: '#E8F4EF',
  tileWarmA: '#FFEFE3',
  tileAirA: '#E5EEFD',
  tileNo2A: '#F0E8FB',

  // Radii
  radiusCard: 22,
  radiusButton: 14,
  radiusTile: 20,
  radiusInput: 16,
  radiusPill: 999,

  // Spacing scale
  space2: 2,
  space4: 4,
  space6: 6,
  space8: 8,
  space12: 12,
  space16: 16,
  space20: 20,
  space24: 24,
  space32: 32,
} as const;

export interface ShadowToken {
  color: string;
  offsetX: number;
  offsetY: number;
  blurRadius: number;
}

export const shadowCard: ShadowToken = {
  color: 'rgba(0, 0, 0, 0.067)',
  offsetX: 0,
  offsetY: 4,
  blurRadius: 12,
};

export const shadowFab: ShadowToken = {
  color: 'rgba(15, 107, 92, 0.161)',
  offsetX: 0,
  offsetY: 10,
  blurRadius: 24,
};
