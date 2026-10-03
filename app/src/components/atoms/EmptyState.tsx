import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '../../theme/useColors';
import { AtmosphereTextStyles } from '../../theme/textStyles';
import { AtmosphereTokens } from '../../theme/tokens';
import { PrimaryButton } from './PrimaryButton';
import { GhostButton } from './GhostButton';
import { LucideIcon } from 'lucide-react-native';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  body: string;
  primaryAction?: string;
  onPrimaryAction?: () => void;
  secondaryAction?: string;
  onSecondaryAction?: () => void;
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  primaryAction,
  onPrimaryAction,
  secondaryAction,
  onSecondaryAction,
}: EmptyStateProps) {
  const c = useColors();

  return (
    <View style={styles.container}>
      <View style={[styles.iconCircle, { backgroundColor: c.line2 }]}>
        <Icon size={48} color={c.ink3} />
      </View>
      <View style={{ height: AtmosphereTokens.space24 }} />
      <Text style={[AtmosphereTextStyles.h1(c.ink), styles.centerText]}>{title}</Text>
      <View style={{ height: AtmosphereTokens.space12 }} />
      <Text style={[AtmosphereTextStyles.body(c.ink2), styles.centerText]}>{body}</Text>
      {primaryAction && onPrimaryAction ? (
        <>
          <View style={{ height: AtmosphereTokens.space32 }} />
          <PrimaryButton label={primaryAction} onPress={onPrimaryAction} />
        </>
      ) : null}
      {secondaryAction && onSecondaryAction ? (
        <>
          <View style={{ height: AtmosphereTokens.space12 }} />
          <GhostButton label={secondaryAction} onPress={onSecondaryAction} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: AtmosphereTokens.space32,
  },
  iconCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerText: {
    textAlign: 'center',
  },
});
