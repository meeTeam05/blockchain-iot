import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/theme/useColors';
import { AtmosphereAppBar } from '@/components/shell/AtmosphereAppBar';
import { Field } from '@/components/atoms/Field';
import { PrimaryButton } from '@/components/atoms/PrimaryButton';
import { useCreateHome } from '@/queries/homes';

export default function CreateHomeScreen() {
  const c = useColors();
  const router = useRouter();
  const createHome = useCreateHome();

  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('Name required');
      return;
    }
    setNameError(null);
    try {
      await createHome.mutateAsync({ name: trimmed });
      router.back();
    } catch {
      // Error surfaced via createHome.error below.
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <AtmosphereAppBar variant="back" title="New Home" onBack={() => router.back()} />
      <View style={styles.body}>
        <Field
          label="Home name"
          value={name}
          onChangeText={setName}
          errorText={
            nameError ??
            (createHome.error instanceof Error ? createHome.error.message : null)
          }
        />
        <View style={{ height: 24 }} />
        <PrimaryButton label="Create" loading={createHome.isPending} onPress={submit} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { padding: 24 },
});
