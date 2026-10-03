import { ReactNode } from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import { useColors } from '../../theme/useColors';
import { AtmosphereTokens, shadowCard } from '../../theme/tokens';

interface AtmosphereCardProps {
  children: ReactNode;
  padding?: number;
  elevated?: boolean;
  style?: ViewStyle;
}

export function AtmosphereCard({ children, padding, elevated = false, style }: AtmosphereCardProps) {
  const c = useColors();

  return (
    <View
      style={[
        styles.card,
        {
          padding: padding ?? AtmosphereTokens.space16,
          backgroundColor: c.paper,
          borderColor: c.line,
        },
        elevated
          ? {
              shadowColor: shadowCard.color,
              shadowOffset: { width: shadowCard.offsetX, height: shadowCard.offsetY },
              shadowRadius: shadowCard.blurRadius,
              shadowOpacity: 1,
              elevation: 4,
            }
          : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: AtmosphereTokens.radiusCard,
    borderWidth: 1,
  },
});
