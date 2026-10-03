import { test, expect, type Page } from '@playwright/test'

const CONTROL = 'http://127.0.0.1:3006'
async function control(path: string, body: unknown) {
  const response = await fetch(`${CONTROL}/__test/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`Task 8 fixture failed: ${await response.text()}`)
  return response.json()
}
async function wallet(page: Page, prefix: string) {
  const connect = page.getByRole('button', { name: 'Kết nối ví' })
  await expect(connect.or(page.getByRole('button', { name: /^0x/ })).first()).toBeVisible()
  if (await connect.isVisible()) await connect.click()
  for (let attempt = 0; attempt < 3; attempt++) {
    const button = page.getByRole('button', { name: /^0x/ })
    await expect(button).toBeVisible()
    const previous = await button.textContent()
    if (previous?.toLowerCase().startsWith(prefix.toLowerCase())) return
    await page.getByRole('button', { name: 'Đổi tài khoản' }).click()
    await expect.poll(() => button.textContent()).not.toBe(previous)
  }
  throw new Error(`Cannot connect local test wallet ${prefix}`)
}
async function incident(page: Page, sequence: number, options: { danger?: boolean; observedAgo?: number } = {}) {
  const row = await control('incident', { sequence, ...options })
  await page.goto(`/dapp/d/${row.deviceId}/i/${row.incidentId}`)
  await expect(page.getByText('Dữ liệu toàn vẹn')).toBeVisible()
  return row
}
async function ownerAction(page: Page, label: string) {
  // A full navigation creates a fresh wagmi mock connector session.
  await wallet(page, '0x90f7')
  await page.getByRole('button', { name: label, exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận', exact: true }).click()
}

test('one day through the real UI: approve/stake, R1/R2, P1, manual P2, daily cap and cooldown', async ({ page }) => {
  await page.goto('/dapp/wallet')
  await page.getByLabel('Email').fill('task8@local.test')
  await page.getByLabel('Mật khẩu').fill('local-fixture-password')
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  await wallet(page, '0x90f7')
  await expect(page.getByTestId('token-balance')).toContainText('100 ASAFE')
  await page.getByLabel('Số lượng ASAFE').fill('100')
  await expect(page.getByRole('button', { name: 'Approve → Stake' })).toBeEnabled()
  await page.getByRole('button', { name: 'Approve → Stake' }).click()
  await expect(page.getByTestId('bond-amount')).toHaveText('Bond chain: 100 ASAFE')
  await expect(page.getByTestId('token-balance')).toHaveText('Số dư chain: 0 ASAFE')

  await incident(page, 1)
  await expect(page.getByTestId('ack-countdown')).toContainText('Hạn acknowledge:')
  await ownerAction(page, 'Xác nhận')
  await expect(page.getByText('Chain: đã thưởng ack', { exact: true })).toBeVisible()
  await ownerAction(page, 'Đã xử lý')
  await expect(page.getByText('Chain: resolve đã settlement (thưởng hoặc skipped)', { exact: true })).toBeVisible()

  const second = await incident(page, 2, { danger: true })
  await control('time', { seconds: 601 })
  await page.reload()
  await expect(page.getByTestId('ack-countdown')).toContainText('Quá hạn')
  await page.goto('/dapp/keeper')
  await wallet(page, '0x15d3')
  await expect(page.getByText('Bounty canonical: +10 ASAFE', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Phạt missed ack', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Phạt missed ack', exact: true })).toHaveCount(0)
  await page.goto(`/dapp/d/${second.deviceId}/i/${second.incidentId}`)
  await wallet(page, '0x90f7')
  await ownerAction(page, 'Xác nhận')
  await expect(page.getByText('Chain: owner đã bị phạt', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ghi nhận thưởng ack', exact: true })).toHaveCount(0)

  const third = await incident(page, 3, { observedAgo: 1500 })
  await page.goto('/dapp/keeper')
  await wallet(page, '0x15d3')
  await expect(page.getByRole('button', { name: 'Phạt relay trễ (operator)', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Phạt relay trễ (operator)', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Phạt relay trễ (operator)', exact: true })).toHaveCount(0)
  await page.goto(`/dapp/d/${third.deviceId}/i/${third.incidentId}`)
  await wallet(page, '0x90f7')
  await ownerAction(page, 'Xác nhận')
  await expect(page.getByText('Chain: đã thưởng ack', { exact: true })).toBeVisible()
  await expect(page.getByText('2/3 lượt thưởng hôm nay', { exact: true })).toBeVisible()
  await expect(page.getByText('Chain: relay trễ, operator bị phạt', { exact: true })).toBeVisible()

  for (const sequence of [4, 5, 6]) {
    await incident(page, sequence)
    await ownerAction(page, 'Xác nhận')
    if (sequence === 4) await expect(page.getByText('Chain: đã thưởng ack', { exact: true })).toBeVisible()
    else {
      await expect(page.getByText('API projection: Vượt trần ngày: không thưởng', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Ghi nhận thưởng ack', exact: true })).toHaveCount(0)
    }
  }
  await page.goto('/dapp/wallet')
  await wallet(page, '0x90f7')
  await expect(page.getByTestId('token-balance')).toContainText('20 ASAFE')
  await expect(page.getByTestId('bond-amount')).toHaveText('Bond chain: 80 ASAFE')
  await expect(page.getByText('3/3 lượt thưởng hôm nay (chain)', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Đối chiếu lịch sử incentives on-chain' }).click()
  await expect(page.getByText(/On-chain MissedAckSlashed/)).toBeVisible()

  await page.goto('/dapp/params')
  await expect(page.getByText('Quỹ thưởng canonical: 49980 ASAFE', { exact: true })).toBeVisible()
  await expect(page.getByText('Operator bond canonical: 980 ASAFE', { exact: true })).toBeVisible()
  await expect(page.getByText(/ParamsUpdated ·/)).toBeVisible()

  await control('set-params', { ackReward: String(60000n * 10n ** 18n), dailyRewardCap: 100 })
  await incident(page, 7)
  await ownerAction(page, 'Xác nhận')
  await expect(page.getByText(/RewardSkipped.*InsufficientFund/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ghi nhận thưởng ack', exact: true })).toHaveCount(0)

  await page.goto('/dapp/wallet')
  await wallet(page, '0x90f7')
  await page.getByRole('button', { name: 'Yêu cầu unstake', exact: true }).click()
  await expect(page.getByText(/giây cooldown/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Withdraw bond', exact: true })).toBeDisabled()
  await control('time', { seconds: 604800 })
  await page.reload()
  await wallet(page, '0x90f7')
  await expect(page.getByRole('button', { name: 'Withdraw bond', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Withdraw bond', exact: true }).click()
  await expect(page.getByTestId('bond-amount')).toHaveText('Bond chain: 0 ASAFE')
  await expect(page.getByTestId('token-balance')).toContainText('100 ASAFE')
})
