import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useColors } from '../../theme/useColors';
import { AtmosphereTextStyles } from '../../theme/textStyles';

interface PromptDialogProps {
  visible: boolean;
  title: string;
  label: string;
  initialValue?: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}

/** Cross-platform replacement for Alert.prompt (iOS-only in RN) and Dart's
 * showDialog + TextFormField prompt pattern. */
export function PromptDialog({ visible, ...contentProps }: PromptDialogProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={contentProps.onCancel}>
      {/* Mounting only while visible gives each open a fresh `value` state,
          instead of syncing it from `initialValue` via an effect. */}
      {visible ? <PromptDialogContent {...contentProps} /> : null}
    </Modal>
  );
}

function PromptDialogContent({
  title,
  label,
  initialValue = '',
  onCancel,
  onSubmit,
}: Omit<PromptDialogProps, 'visible'>) {
  const c = useColors();
  const [value, setValue] = useState(initialValue);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <View style={styles.backdrop}>
      <View style={[styles.card, { backgroundColor: c.surface }]}>
        <Text style={AtmosphereTextStyles.h2(c.ink)}>{title}</Text>
        <View style={{ height: 12 }} />
        <TextInput
          value={value}
          onChangeText={setValue}
          placeholder={label}
          placeholderTextColor={c.textSecondary}
          autoFocus
          onSubmitEditing={submit}
          style={[styles.input, AtmosphereTextStyles.body(c.ink), { borderColor: c.border }]}
        />
        <View style={{ height: 20 }} />
        <View style={styles.actions}>
          <Pressable onPress={onCancel} style={styles.actionButton}>
            <Text style={AtmosphereTextStyles.body(c.ink3)}>Cancel</Text>
          </Pressable>
          <Pressable onPress={submit} style={styles.actionButton}>
            <Text style={AtmosphereTextStyles.body(c.brand)}>Save</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    width: '85%',
    borderRadius: 16,
    padding: 20,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 16,
  },
  actionButton: {
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
});
