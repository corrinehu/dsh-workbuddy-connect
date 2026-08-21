#!/usr/bin/env node
/**
 * Shim security verification (phase 1): proves the hardened shim rejects
 * hostile inbound requests while accepting the legitimate loopback client.
 *
 * Usage: node scripts/verify-shim-hardening.mjs
 *
 * It spins up the shim with a fake upstream, then fires four raw HTTP
 * requests at it:
 *   1. hostile Host (DNS-rebinding shape)          -> expect 403
 *   2. hostile browser Origin (cross-site page)    -> expect 403
 *   3. non-JSON Content-Type (simple CSRF shape)   -> expect 415
 *   4. legitimate loopback shape (own client)      -> expect 200
 * Exits 0 only when all four behave as hardened code should.
 */
import { request } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkBuddyShim,
  WorkBuddyCatalog,
  WorkBuddyCredentialStore,
} from '../lib/index.js'

function rawRequest(port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const dir = await mkdtemp(join(tmpdir(), 'wb-verify-'))
await writeFile(join(dir, 'auth.json'), JSON.stringify({
  auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
  account: { uid: 'uid-1' },
}))

const store = new WorkBuddyCredentialStore({
  desktopPath: join(dir, 'auth.json'),
  ownPath: join(dir, 'own.json'),
  refresh: async () => ({ accessToken: 'unused' }),
})
const shim = createWorkBuddyShim({
  store,
  catalog: new WorkBuddyCatalog(),
  client: {
    async chatStream() {
      return { ok: true, response: new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) }
    },
  },
})
await shim.ready
const port = Number(new URL(shim.baseUrl()).port)

let failures = 0
const check = (name, actual, expected) => {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${actual}, expected ${expected}`)
  if (!ok) failures += 1
}

// 1. DNS-rebinding shape: hostile Host
check('hostile Host rejected (DNS rebinding)',
  (await rawRequest(port, 'GET', '/healthz', { host: 'evil.com' })).status, 403)

// 2. Cross-site browser page: hostile Origin
check('hostile Origin rejected (browser CSRF)',
  (await rawRequest(port, 'POST', '/v1/chat/completions', {
    host: `127.0.0.1:${port}`, origin: 'https://evil.com', 'content-type': 'application/json',
  }, JSON.stringify({ model: 'auto', messages: [] }))).status, 403)

// 3. Simple-request CSRF shape: non-JSON Content-Type
check('non-JSON Content-Type rejected (415)',
  (await rawRequest(port, 'POST', '/v1/chat/completions', {
    host: `127.0.0.1:${port}`, 'content-type': 'text/plain',
  }, JSON.stringify({ model: 'auto', messages: [] }))).status, 415)

// 4. Legitimate loopback client shape (own fetch: loopback Host, no Origin, JSON)
check('legitimate loopback request accepted',
  (await rawRequest(port, 'POST', '/v1/chat/completions', {
    host: `127.0.0.1:${port}`, 'content-type': 'application/json',
  }, JSON.stringify({ model: 'auto', messages: [] }))).status, 200)

await shim.close()
await rm(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nSHIM HARDENING VERIFIED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
