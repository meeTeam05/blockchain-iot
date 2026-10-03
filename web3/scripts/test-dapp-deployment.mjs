import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

const root = new URL('../dist/', import.meta.url)
const index = await readFile(new URL('index.html', root))
const html = index.toString('utf8')
const assetPath = html.match(/(?:src|href)="(\/dapp\/assets\/[^"]+)"/)?.[1]
assert.ok(assetPath, 'built index must reference an asset below /dapp/assets/')

const mime = new Map([
  ['.css', 'text/css'],
  ['.js', 'text/javascript'],
  ['.html', 'text/html'],
])

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (!pathname.startsWith('/dapp/')) {
    response.writeHead(404).end()
    return
  }

  const relative = normalize(pathname.slice('/dapp/'.length))
  const candidate = relative && !relative.startsWith('..') ? join(root.pathname, relative) : null
  try {
    const body = candidate ? await readFile(candidate) : index
    response.setHeader('content-type', mime.get(extname(candidate ?? 'index.html')) ?? 'application/octet-stream')
    response.writeHead(200).end(body)
  } catch {
    response.setHeader('content-type', 'text/html')
    response.writeHead(200).end(index)
  }
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert.equal(typeof address, 'object')
const origin = `http://127.0.0.1:${address.port}`

try {
  const verify = `/dapp/verify/${encodeURIComponent('dc:b4:d9:13:ed:8c')}/0x${'34'.repeat(32)}`
  for (const route of ['/dapp/', '/dapp/d/device-1', '/dapp/d/device-1/i/incident-1', verify, '/dapp/wallet', '/dapp/keeper', '/dapp/params']) {
    const response = await fetch(`${origin}${route}`)
    assert.equal(response.status, 200, `${route} should return 200`)
    assert.match(response.headers.get('content-type') ?? '', /text\/html/)
    assert.equal(await response.text(), html, `${route} should use the SPA entry point`)
  }

  const assetResponse = await fetch(`${origin}${assetPath}`)
  assert.equal(assetResponse.status, 200, `${assetPath} should return 200`)
  assert.doesNotMatch(assetResponse.headers.get('content-type') ?? '', /text\/html/)
  assert.ok((await assetResponse.arrayBuffer()).byteLength > 0, 'built asset must not be empty')

  const reload = await fetch(`${origin}/dapp/d/device-1/i/incident-1`)
  assert.equal(reload.status, 200, 'direct nested-route reload should return 200')
  const verifyReload = await fetch(`${origin}${verify}`)
  assert.equal(verifyReload.status, 200, 'direct /dapp/verify reload should return 200')
  console.log(`dApp deployment routes PASS (asset: ${assetPath})`)
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}
