import { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useColors } from '../../theme/useColors';
import { AppIcons } from '../../theme/icons';
import { AtmosphereTokens } from '../../theme/tokens';
import { StepDots } from '../atoms/StepDots';
import { PrimaryButton } from '../atoms/PrimaryButton';
import { GhostButton } from '../atoms/GhostButton';

interface BleStepShellProps {
  currentStep: number;
  title: string;
  subtitle: string;
  body: ReactNode;
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  primaryLoading?: boolean;
  primaryEnabled?: boolean;
  onCancel: () => void;
}

export function BleStepShell({
  currentStep,
  title,
  subtitle,
  body,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  primaryLoading = false,
  primaryEnabled = true,
  onCancel,
}: BleStepShellProps) {
  const c = useColors();

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.bg }]} edges={['top', 'bottom']}>
      <View style={styles.content}>
        <View style={styles.headerRow}>
          <Pressable onPress={onCancel} hitSlop={8}>
            <AppIcons.close size={22} color={c.ink} />
          </Pressable>
          <View style={{ flex: 1 }} />
          <Text style={[styles.provisioningLabel, { color: c.ink3 }]}>Provisioning</Text>
          <View style={{ flex: 2 }} />
        </View>
        <View style={{ height: AtmosphereTokens.space12 }} />
        <StepDots current={currentStep} total={5} />
        <View style={{ height: AtmosphereTokens.space24 }} />
        <Text style={[styles.title, { color: c.ink }]}>{title}</Text>
        <View style={{ height: AtmosphereTokens.space8 }} />
        <Text style={[styles.subtitle, { color: c.ink2 }]}>{subtitle}</Text>
        <View style={{ height: AtmosphereTokens.space24 }} />
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
          {body}
        </ScrollView>
        <View style={{ height: AtmosphereTokens.space16 }} />
        <PrimaryButton
          label={primaryLabel}
          loading={primaryLoading}
          disabled={!primaryEnabled}
          onPress={onPrimary}
        />
        {secondaryLabel && onSecondary ? (
          <>
            <View style={{ height: AtmosphereTokens.space12 }} />
            <GhostButton label={secondaryLabel} onPress={onSecondary} />
          </>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: {
    flex: 1,
    paddingHorizontal: AtmosphereTokens.space20,
    paddingTop: AtmosphereTokens.space12,
    paddingBottom: AtmosphereTokens.space20,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  provisioningLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.6,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
  },
});
