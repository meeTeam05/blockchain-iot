// Display helpers shared by the device list card and the device page header.

export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'chưa ghi nhận'
  try {
    const diffMs = Date.now() - new Date(dateStr).getTime()
    if (diffMs < 0) return 'vừa xong'
    const diffMinutes = Math.floor(diffMs / 60000)
    if (diffMinutes < 1) return 'vừa xong'
    if (diffMinutes < 60) return `${diffMinutes} phút trước`
    const diffHours = Math.floor(diffMinutes / 60)
    if (diffHours < 24) return `${diffHours} giờ trước`
    const diffDays = Math.floor(diffHours / 24)
    return `${diffDays} ngày trước`
  } catch {
    return dateStr
  }
}
