import { describe, expect, it } from 'vitest'
import { deriveIncidentStatus, mergeIncidentStatus } from './mergeStatus'

describe('mergeIncidentStatus (B3 table)', () => {
  it('queued/pending + None -> đang đưa lên chain', () => {
    expect(mergeIncidentStatus('queued', 'None').label).toBe('Đang đưa lên chain')
    expect(mergeIncidentStatus('pending', 'None').label).toBe('Đang đưa lên chain')
  })
  it('any API status + Logged -> đã ghi on-chain', () => {
    expect(mergeIncidentStatus('queued', 'Logged').label).toBe('Đã ghi on-chain, chờ xử lý')
    expect(mergeIncidentStatus(null, 'Logged').label).toBe('Đã ghi on-chain, chờ xử lý')
  })
  it('any API status + Acknowledged -> đã xác nhận', () => {
    expect(mergeIncidentStatus('failed', 'Acknowledged').label).toBe('Đã xác nhận')
  })
  it('any API status + Resolved -> đã xử lý xong', () => {
    expect(mergeIncidentStatus('failed', 'Resolved').label).toBe('Đã xử lý xong')
  })
  it('failed/blocked + None -> lỗi đưa lên chain', () => {
    expect(mergeIncidentStatus('failed', 'None').label).toBe('Lỗi đưa lên chain')
    expect(mergeIncidentStatus('blocked', 'None').label).toBe('Lỗi đưa lên chain')
  })
  it('legacy_domain + None -> ký cho contract cũ', () => {
    expect(mergeIncidentStatus('legacy_domain', 'None').label).toBe('Ký cho contract cũ, không lên chain')
  })

  it('never treats an RPC error as on-chain None', () => {
    expect(deriveIncidentStatus('pending', 'error').label).toBe('Chain không khả dụng')
    expect(deriveIncidentStatus('pending', 'loading').label).toBe('Đang đọc chain')
  })

  it('shows an explicit not-on-chain state when both sources have no record', () => {
    expect(deriveIncidentStatus(null, 'success', 'None').label).toBe('Chưa có trên chain')
  })
})
