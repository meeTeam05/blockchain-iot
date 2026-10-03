import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet } from 'react-native';
import { useColors } from '../../theme/useColors';

// Port of app/lib/widgets/atoms/atmosphere_switch.dart — a custom animated
// track/thumb toggle, in place of RN's native Switch, to match the Dart
// visual exactly. ModeCard/RelayCard used the native Switch as a stand-in
// until this existed (see AtmosphereSwitch cosmetic-parity item).
export type SwitchSize = 'normal' | 'large';

interface AtmosphereSwitchProps {
  value: boolean;
  onChange?: (value: boolean) => void;
  size?: SwitchSize;
  accessibilityLabel?: string;
}

const SIZES: Record<SwitchSize, { trackWidth: number; trackHeight: number; thumbSize: number; outerWidth: number }> = {
  normal: { trackWidth: 52, trackHeight: 30, thumbSize: 24, outerWidth: 64 },
  large: { trackWidth: 58, trackHeight: 34, thumbSize: 28, outerWidth: 72 },
};

const TRACK_PADDING = 3;
const ANIMATION_DURATION_MS = 200;

export function AtmosphereSwitch({ value, onChange, size = 'normal', accessibilityLabel }: AtmosphereSwitchProps) {
  const c = useColors();
  const { trackWidth, trackHeight, thumbSize, outerWidth } = SIZES[size];
  // useState (not useRef) so `.interpolate()` calls below during render
  // aren't flagged by the react-hooks/refs rule — the value is still
  // created once and stays stable across renders, same as useRef would give.
  const [progress] = useState(() => new Animated.Value(value ? 1 : 0));

  useEffect(() => {
    Animated.timing(progress, {
      toValue: value ? 1 : 0,
      duration: ANIMATION_DURATION_MS,
      easing: Easing.inOut(Easing.ease),
      // Color and layout (non-transform) properties aren't supported by the
      // native driver.
      useNativeDriver: false,
    }).start();
  }, [value, progress]);

  const trackColor = progress.interpolate({ inputRange: [0, 1], outputRange: [c.line2, c.brand] });
  const thumbColor = progress.interpolate({ inputRange: [0, 1], outputRange: [c.ink3, c.paper] });
  const thumbTravel = trackWidth - thumbSize - TRACK_PADDING * 2;
  const thumbTranslateX = progress.interpolate({ inputRange: [0, 1], outputRange: [0, thumbTravel] });

  return (
    <Pressable
      onPress={onChange ? () => onChange(!value) : undefined}
      disabled={!onChange}
      accessibilityRole="switch"
      accessibilityState={{ disabled: !onChange, checked: value }}
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      style={[styles.outer, { width: outerWidth, opacity: onChange ? 1 : 0.6 }]}
    >
      <Animated.View
        style={[
          styles.track,
          { width: trackWidth, height: trackHeight, borderRadius: trackHeight / 2, backgroundColor: trackColor },
        ]}
      >
        <Animated.View
          style={[
            styles.thumb,
            {
              width: thumbSize,
              height: thumbSize,
              borderRadius: thumbSize / 2,
              backgroundColor: thumbColor,
              transform: [{ translateX: thumbTranslateX }],
            },
          ]}
        />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  outer: {
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  track: {
    padding: TRACK_PADDING,
  },
  thumb: {},
});
