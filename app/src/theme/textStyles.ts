import type { TextStyle } from 'react-native';

/**
 * Font family names as registered with expo-font (Phase 7). Mirrors the
 * PlusJakartaSans/JetBrainsMono static weights declared in the original
 * pubspec.yaml — React Native needs one family name per static weight,
 * unlike Flutter's GoogleFonts helper which picks the file for you.
 */
export const FontFamily = {
  regular: 'PlusJakartaSans-Regular',
  medium: 'PlusJakartaSans-Medium',
  semiBold: 'PlusJakartaSans-SemiBold',
  bold: 'PlusJakartaSans-Bold',
  mono: 'JetBrainsMono-Regular',
} as const;

export const AtmosphereTextStyles = {
  pageTitle: (color: string): TextStyle => ({
    fontFamily: FontFamily.bold,
    fontSize: 36,
    fontWeight: '700',
    letterSpacing: -0.9,
    color,
  }),
  h1: (color: string): TextStyle => ({
    fontFamily: FontFamily.bold,
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.5,
    color,
  }),
  h2: (color: string): TextStyle => ({
    fontFamily: FontFamily.bold,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.4,
    color,
  }),
  sensorValue: (color: string): TextStyle => ({
    fontFamily: FontFamily.bold,
    fontSize: 30,
    fontWeight: '700',
    letterSpacing: -0.75,
    color,
  }),
  label: (color: string): TextStyle => ({
    fontFamily: FontFamily.bold,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.4,
    color,
  }),
  body: (color: string): TextStyle => ({
    fontFamily: FontFamily.medium,
    fontSize: 15,
    fontWeight: '500',
    color,
  }),
  caption: (color: string): TextStyle => ({
    fontFamily: FontFamily.regular,
    fontSize: 13,
    fontWeight: '400',
    color,
  }),
  pill: (color: string): TextStyle => ({
    fontFamily: FontFamily.semiBold,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
    color,
  }),
  mono: (color: string, size = 13): TextStyle => ({
    fontFamily: FontFamily.mono,
    fontSize: size,
    fontWeight: '400',
    color,
  }),
};
