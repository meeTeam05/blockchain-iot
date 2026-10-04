// Display helpers shared by the device incident table and the incident page.
// Titles follow tmp/06_web/device/Thiet bi.dc.html; the kind of a listed
// incident is derived from overall_level because the server rejects evidence
// whose incident_kind does not match it (incident-verify.js, LEVEL_KIND_SEVERITY).
import type { ApiIncidentSummary } from './incidentsApi'

export type IncidentKind = 'EARLY_WARNING_ENTERED' | 'THRESHOLD_EXCEEDED_ENTERED'

const KIND_TITLES: Record<IncidentKind, string> = {
  EARLY_WARNING_ENTERED: 'Cảnh báo sớm: nguy cơ vượt ngưỡng',
  THRESHOLD_EXCEEDED_ENTERED: 'Nồng độ khí vượt ngưỡng an toàn',
}

export function kindFromLevel(level: ApiIncidentSummary['overall_level']): IncidentKind | null {
  if (level === 'EARLY_WARNING') return 'EARLY_WARNING_ENTERED'
  if (level === 'EXCEEDED') return 'THRESHOLD_EXCEEDED_ENTERED'
  return null
}

export function incidentTitle(kind: string | null | undefined): string {
  return KIND_TITLES[kind as IncidentKind] ?? 'Chi tiết sự cố an toàn không khí'
}

export interface SeverityDisplay {
  label: string
  color: string
  badgeTone: 'amber' | 'red' | 'grey'
}

export function severityDisplay(severity: ApiIncidentSummary['severity']): SeverityDisplay {
  if (severity === 'warning') return { label: 'Cảnh báo', color: '#b45309', badgeTone: 'amber' }
  if (severity === 'danger' || severity === 'critical') return { label: 'Nghiêm trọng', color: '#c81e3a', badgeTone: 'red' }
  return { label: 'Thông tin', color: '#5d6a60', badgeTone: 'grey' }
}

const pad = (n: number) => String(n).padStart(2, '0')

// "09:57 · 02/10" (table) or "09:57:06 · 02/10/2026" (header).
export function formatIncidentTime(epochSeconds: string, full = false): string {
  const date = new Date(Number(epochSeconds) * 1000)
  if (Number.isNaN(date.getTime())) return epochSeconds
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}${full ? `:${pad(date.getSeconds())}` : ''}`
  const day = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}${full ? `/${date.getFullYear()}` : ''}`
  return `${time} · ${day}`
}
