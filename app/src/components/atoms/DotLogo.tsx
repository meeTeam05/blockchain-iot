import Svg, { Circle } from 'react-native-svg';

interface DotLogoProps {
  size?: number;
  color: string;
}

const DOT_POSITIONS: [x: number, y: number, opacity: number][] = [
  [0, 0, 0.3],
  [1, 0, 0.5],
  [2, 0, 0.7],
  [3, 0, 0.5],
  [4, 0, 0.3],
  [0, 1, 0.5],
  [1, 1, 1.0],
  [2, 1, 1.0],
  [3, 1, 1.0],
  [4, 1, 0.5],
  [0, 2, 0.7],
  [1, 2, 1.0],
  [2, 2, 1.0],
  [3, 2, 1.0],
  [4, 2, 0.7],
  [0, 3, 0.5],
  [1, 3, 1.0],
  [2, 3, 1.0],
  [3, 3, 1.0],
  [4, 3, 0.5],
  [0, 4, 0.3],
  [1, 4, 0.5],
  [2, 4, 0.7],
  [3, 4, 0.5],
  [4, 4, 0.3],
];

export function DotLogo({ size = 40, color }: DotLogoProps) {
  const dotSize = size / 9;
  const spacing = size / 6;

  return (
    <Svg width={size} height={size}>
      {DOT_POSITIONS.map(([x, y, opacity], i) => (
        <Circle
          key={i}
          cx={x * spacing + dotSize / 2}
          cy={y * spacing + dotSize / 2}
          r={dotSize / 2}
          fill={color}
          fillOpacity={opacity}
        />
      ))}
    </Svg>
  );
}
