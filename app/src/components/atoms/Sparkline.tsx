import { useState } from 'react';
import { LayoutChangeEvent, View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';

interface SparklineProps {
  points: number[];
  color: string;
  height?: number;
  /** Maximum number of data points to render. Older points are dropped. */
  maxPoints?: number;
}

export function Sparkline({ points, color, height = 40, maxPoints = 30 }: SparklineProps) {
  const [width, setWidth] = useState(0);

  if (points.length === 0) {
    return <View style={{ height }} />;
  }

  const trimmed = points.length > maxPoints ? points.slice(points.length - maxPoints) : points;
  const min = Math.min(...trimmed);
  const max = Math.max(...trimmed);
  const range = max - min || 1;

  function onLayout(e: LayoutChangeEvent) {
    setWidth(e.nativeEvent.layout.width);
  }

  const coords =
    width > 0
      ? trimmed
          .map((value, i) => {
            const x = trimmed.length === 1 ? width : (i / (trimmed.length - 1)) * width;
            const y = height - ((value - min) / range) * height;
            return `${x},${y}`;
          })
          .join(' ')
      : '';

  return (
    <View style={{ height, width: '100%' }} onLayout={onLayout}>
      {width > 0 ? (
        <Svg width={width} height={height}>
          <Polyline
            points={coords}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      ) : null}
    </View>
  );
}
