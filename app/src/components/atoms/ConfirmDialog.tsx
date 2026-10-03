import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '../../theme/useColors';
import { AtmosphereTextStyles } from '../../theme/textStyles';

interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Cross-platform replacement for Dart's showDialog(AlertDialog) confirm pattern. */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = 'Delete',
  destructive = true,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const c = useColors();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: c.surface }]}>
          <Text style={AtmosphereTextStyles.h2(c.ink)}>{title}</Text>
          <View style={{ height: 8 }} />
          <Text style={AtmosphereTextStyles.body(c.ink2)}>{message}</Text>
          <View style={{ height: 20 }} />
          <View style={styles.actions}>
            <Pressable onPress={onCancel} style={styles.actionButton}>
              <Text style={AtmosphereTextStyles.body(c.ink3)}>Cancel</Text>
            </Pressable>
            <Pressable onPress={onConfirm} style={styles.actionButton}>
              <Text style={AtmosphereTextStyles.body(destructive ? c.danger : c.brand)}>
                {confirmLabel}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
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
