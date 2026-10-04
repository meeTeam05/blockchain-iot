// 1800 -> "30 phút", 86400 -> "24 giờ", 604800 -> "7 ngày" (contract values are seconds).
export function formatDuration(value: bigint | number) {
  const seconds = Number(value)
  if (seconds >= 2 * 86400 && seconds % 86400 === 0) return `${seconds / 86400} ngày`
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} giờ`
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} phút`
  return `${seconds} giây`
}
