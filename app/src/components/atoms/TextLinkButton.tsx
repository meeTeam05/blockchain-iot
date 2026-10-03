import { Pressable, Text } from 'react-native';
import { useColors } from '../../theme/useColors';
import { AtmosphereTextStyles } from '../../theme/textStyles';

interface TextLinkButtonProps {
  label: string;
  onPress: () => void;
}

export function TextLinkButton({ label, onPress }: TextLinkButtonProps) {
  const c = useColors();

  return (
    <Pressable onPress={onPress} hitSlop={8}>
      <Text style={[AtmosphereTextStyles.body(c.brand), { textDecorationLine: 'underline' }]}>
        {label}
      </Text>
    </Pressable>
  );
}
