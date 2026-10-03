import { AtmosphereTokens } from './tokens';

/** Brand colors safe to reference directly, regardless of light/dark theme.
 * Theme-adaptive colors (bg, surface, border, text*) go through
 * theme/palette.ts instead. Source: app/lib/app_theme.dart AppColors. */
export const AppColors = {
  primary: AtmosphereTokens.brand,
  online: '#1A8767',
  offline: AtmosphereTokens.ink3,
  warning: AtmosphereTokens.warn,
} as const;
