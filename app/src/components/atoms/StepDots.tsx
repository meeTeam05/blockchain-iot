import { StyleSheet, View } from 'react-native';
import { useColors } from '../../theme/useColors';

interface StepDotsProps {
  current: number;
  total: number;
}

export function StepDots({ current, total }: StepDotsProps) {
  const c = useColors();

  return (
    <View style={styles.row}>
      {Array.from({ length: total }, (_, index) => {
        const isActive = index === current;
        const isPast = index < current;
        return (
          <View
            key={index}
            style={[
              styles.dot,
              {
                width: isActive ? 24 : 8,
                backgroundColor: isActive || isPast ? c.brand : c.line2,
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dot: {
    height: 8,
    borderRadius: 4,
    marginHorizontal: 4,
  },
});
