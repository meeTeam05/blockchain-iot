// Web3_task.md muc 7, Kich ban A (E2E incident, Task 5): connect, verify, ack, resolve.
// Web3_task.md muc 9 "E2E UI": chay tren hardhat, vi mo phong bang mock connector
// cua wagmi (xem src/lib/wagmiConfig.ts + playwright.config.ts) -- khong can
// MetaMask that. Giong cac file server/api/test/e2e/*.test.js, test nay doi hoi
// ha tang that da dung san (hardhat node + full docker-compose backend), vi
// IncidentPage doc incident qua API that, khong chi qua chain truc tiep.
import { test, expect } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import mqtt from 'mqtt'
import { Contract, SigningKey, computeAddress } from 'ethers'
// @ts-expect-error -- plain JS helper, no type declarations published.
import { createProvider, registerDevice } from '../../server/api/test/helpers/chain-deploy.js'
// @ts-expect-error -- plain JS helper, no type declarations published.
import { registerSigner } from '../../server/api/src/services/device-signers.js'
import { config } from '../../server/api/src/config.js'
// @ts-expect-error -- generated, see spec/incident/gen/gen-all.mjs.
import { AIR_SAFETY_LOG_ABI, INCIDENT_DEPLOYMENTS } from '../../server/api/src/generated/incident-deployments.js'
import pg from 'pg'
import { computeDeviceIdHash } from '../src/lib/chainIncident'

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3000/api'
const RPC_URL = process.env.E2E_CHAIN_RPC_URL ?? 'http://127.0.0.1:8545'
const MQTT_URL = process.env.E2E_MQTT_TLS_URL ?? 'mqtts://127.0.0.1:8883'
const OWNER_ADDRESS = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' // KEYS.owner, matches playwright.config.ts's VITE_E2E_MOCK_ACCOUNT

function randomMac() {
  return [...randomBytes(6)].map((b, i) => (i === 0 ? b & 0xfe : b).toString(16).padStart(2, '0')).join(':')
}

async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

function connectDevice(deviceId: string, secretKey: string): Promise<mqtt.MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(MQTT_URL, {
      username: deviceId,
      password: secretKey,
      clientId: `playwright-e2e-${deviceId}`,
      rejectUnauthorized: false,
      reconnectPeriod: 0,
      connectTimeout: 10_000,
    })
    client.once('connect', () => resolve(client))
    client.once('error', reject)
  })
}

function nextAck(client: mqtt.MqttClient, timeoutMs = 15_000): Promise<{ accepted: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no incident ACK received')), timeoutMs)
    client.once('message', (_topic, message) => {
      clearTimeout(timer)
      resolve(JSON.parse(message.toString()))
    })
  })
}

let deviceId: string
let incidentId: string
let loginEmail: string
let loginPassword: string

test.beforeAll(async () => {
  const health = await fetch(`${API_URL}/health/ready`).then((r) => r.ok).catch(() => false)
  test.skip(!health, `backend not reachable at ${API_URL} -- start docker compose + hardhat node first`)

  // 1. Real user/home/device through the real HTTP API (same as the manual app flow).
  const email = `e2e-playwright-${Date.now()}@example.com`
  const password = 'e2e-password-123'
  loginEmail = email
  loginPassword = password
  const reg = await api('POST', '/auth/register', { body: { email, password } })
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg)}`)
  const login = await api('POST', '/auth/login', { body: { email, password } })
  const token = login.body.accessToken as string
  const home = await api('POST', '/homes', { token, body: { name: 'Playwright E2E home' } })
  deviceId = randomMac()
  const device = await api('POST', '/devices', { token, body: { device_id: deviceId, name: 'Playwright sensor', home_id: home.body.id } })
  if (device.status !== 201) throw new Error(`create device failed: ${JSON.stringify(device)}`)
  const secretKey = device.body.secret_key as string

  // 2. Device registered directly on-chain, on the contract ALREADY deployed at
  // the canonical localhost address (the running dApp reads that static address
  // from src/generated/incident-deployments.ts -- deploying a second instance
  // here would land at a different address once the node's nonce has advanced,
  // which the dApp would never see). Bypasses the DB op queue/chain-worker wait
  // for speed, same approach as ownerActions.integration.test.tsx.
  const provider = createProvider(RPC_URL)
  const contract = new Contract(INCIDENT_DEPLOYMENTS.localhost.address, AIR_SAFETY_LOG_ABI, provider)
  const signingKey = new SigningKey(`0x${randomBytes(32).toString('hex')}`)
  const signerAddress = computeAddress(signingKey)
  await registerDevice(contract, provider, computeDeviceIdHash(deviceId), signerAddress, OWNER_ADDRESS)

  // 3. Signer activated directly in the DB (same shortcut as incident-mqtt.e2e.test.js)
  // so the MQTT-published incident below is accepted without waiting on the chain worker.
  const pool = new pg.Pool({ host: '127.0.0.1', port: 5432, database: config.db.database, user: config.db.user, password: config.db.password })
  await registerSigner(pool, deviceId, signerAddress)
  await pool.end()

  // 4. A real device publishes a real EIP-712-signed incident over MQTT/TLS to the
  // real EMQX broker -- this is what makes it land in the DB that IncidentPage reads.
  const { readFile } = await import('node:fs/promises')
  const vector = JSON.parse(await readFile(new URL('../../docs/test-vectors/incident-v2-model-early-warning.json', import.meta.url), 'utf8'))
  const { signIncident } = await import('../../server/api/test/helpers/incident-signing.js')
  const { resolveIncidentDomains } = await import('../../server/api/src/services/incident-domains.js')
  const { current: domain } = resolveIncidentDomains(config.incident)
  const now = Math.floor(Date.now() / 1000)
  const payload = signIncident({
    vector,
    domain,
    signingKey,
    payload: { ...vector.evidence, device_id: deviceId, firmware_version: vector.transport.firmware_version },
    overrides: { sequence: '1', observed_at: String(now) },
  })
  incidentId = payload.incident_id

  const client = await connectDevice(deviceId, secretKey)
  await client.subscribeAsync(`device/${deviceId}/incident/ack`, { qos: 1 })
  const ackPromise = nextAck(client)
  await client.publishAsync(`device/${deviceId}/incident`, JSON.stringify(payload), { qos: 1 })
  const ack = await ackPromise
  client.end()
  if (!ack.accepted) throw new Error(`incident not accepted: ${JSON.stringify(ack)}`)

  // 5. Give the already-running chain-worker a few poll cycles to submit
  // logIncident on-chain (CHAIN_POLL_INTERVAL_MS=5000 in server/.env).
  await new Promise((resolve) => setTimeout(resolve, 8_000))
})

test.describe('Kich ban A: E2E incident', () => {
  test('connect -> verify -> acknowledge -> resolve', async ({ page }) => {
    // B1: dang nhap API that (LoginForm tren HomePage) -- can thiet truoc, vi
    // IncidentPage doc du lieu incident qua API co JWT, khong chi qua chain.
    // Deep-link thẳng vào incident trước login; auth shell phải giữ route.
    await page.goto(`/dapp/d/${deviceId}/i/${incidentId}`)
    await page.getByLabel('Email').fill(loginEmail)
    await page.getByLabel('Mật khẩu').fill(loginPassword)
    await page.getByRole('button', { name: 'Đăng nhập' }).click()
    await expect(page).toHaveURL(new RegExp(`/d/${deviceId}/i/${incidentId}$`))
    await expect(page.getByText('Sự cố #1')).toBeVisible({ timeout: 10_000 })

    // Kết nối account không phải owner trước: action phải bị chặn.
    await page.getByRole('button', { name: 'Kết nối ví' }).click()
    await expect(page.getByText('Chỉ chủ thiết bị được thao tác')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Xác nhận' })).toHaveCount(0)

    // Account switch sang owner phải cập nhật quyền trên cùng deep-link.
    await page.getByRole('button', { name: 'Đổi tài khoản' }).click()
    await expect(page.getByText('là chủ thiết bị này')).toBeVisible()

    // A3: xac minh doc lap, 4 dong check + "Du lieu toan ven".
    await expect(page.getByText('Dữ liệu toàn vẹn')).toBeVisible({ timeout: 15_000 })

    // A5: bam Xac nhan -> dialog -> confirm -> cho tx mined.
    const ackButton = page.getByRole('button', { name: 'Xác nhận' })
    await expect(ackButton).toBeVisible({ timeout: 15_000 })
    await ackButton.click()
    // ConfirmDialog never overrides confirmLabel, so both ack and resolve use
    // the same default "Xác nhận" button text -- only the dialog title differs.
    await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận' }).click()

    // Reload trong lúc pending/indexing: app phải resume receipt canonical,
    // không gửi lại transaction.
    await page.waitForFunction(() => [...Array(localStorage.length).keys()]
      .map((i) => localStorage.key(i))
      .some((key) => key?.startsWith('smartair-pending-incident-tx:')), null, { timeout: 10_000 })
    await page.reload()

    // The wagmi mock connectors all share the id "mock", so unlike MetaMask the owner
    // account is not restored on reload: reconnect the same way as above. The pending
    // acknowledge is resumed from the public RPC meanwhile and never re-sent.
    await page.getByRole('button', { name: 'Kết nối ví' }).click()
    await page.getByRole('button', { name: 'Đổi tài khoản' }).click()
    await expect(page.getByText('là chủ thiết bị này')).toBeVisible()

    // A7: sau khi acknowledge, nut "Da xu ly" (resolve) phai hien ra.
    const resolveButton = page.getByRole('button', { name: 'Đánh dấu đã xử lý' })
    await expect(resolveButton).toBeVisible({ timeout: 20_000 })
    await expect(ackButton).toHaveCount(0)

    await resolveButton.click()
    await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận' }).click()

    // Resolved: ca 2 nut bien mat (canAcknowledge va canResolve deu false).
    await expect(resolveButton).toHaveCount(0, { timeout: 20_000 })

    // A7: tab Lich su on-chain (tren trang device, khong phai trang incident) co du 4 event.
    await page.goto(`/dapp/d/${deviceId}`)
    await page.getByRole('button', { name: 'Lịch sử on-chain' }).click()
    await expect(page.getByText('DeviceRegistered')).toBeVisible()
    await expect(page.getByText('IncidentLogged')).toBeVisible()
    await expect(page.getByText('IncidentAcknowledged')).toBeVisible()
    await expect(page.getByText('IncidentResolved')).toBeVisible()

    // B4 standalone route: direct load (as from a shared link) verifies from chain.
    await page.goto(`/dapp/verify/${deviceId}/${incidentId}`)
    await expect(page.getByText('Xác minh sự cố')).toBeVisible()
    await expect(page.getByText('Dữ liệu toàn vẹn')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('4/4 checks', { exact: false })).toBeVisible()
  })
})
