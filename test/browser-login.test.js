import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'

import {
  buildSessionCookie,
  decryptV10Cookie,
  deriveAesKey,
  findEdgePath,
  waitForPidExit,
} from '../lib/browser-login.js'

/** Encrypt a plaintext into a Chromium `v10` cookie byte string. */
function encryptV10(plaintext, key, { prefix } = {}) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const input = Buffer.concat([prefix ?? Buffer.alloc(0), Buffer.from(plaintext, 'utf8')])
  const ct = Buffer.concat([cipher.update(input), cipher.final(), cipher.getAuthTag()])
  return Buffer.concat([Buffer.from('v10'), nonce, ct])
}

const key = randomBytes(32)

test('decryptV10Cookie round-trips a value encrypted with the same key', () => {
  const raw = encryptV10('hello 语雀', key)
  assert.equal(decryptV10Cookie(raw, key), 'hello 语雀')
})

test('decryptV10Cookie strips a leading SHA-256(host_key) binding', () => {
  const host = '.yuque.com'
  const raw = encryptV10('SESS-key-123', key, { prefix: createHash('sha256').update(host).digest() })
  assert.equal(decryptV10Cookie(raw, key, { hostKey: host }), 'SESS-key-123')
})

test('decryptV10Cookie keeps the value when no binding matches', () => {
  const raw = encryptV10('plain-value', key)
  // hostKey that does not produce the (absent) prefix must not corrupt the value.
  assert.equal(decryptV10Cookie(raw, key, { hostKey: 'www.other.com' }), 'plain-value')
})

test('decryptV10Cookie rejects non-v10 prefixes with a V20 code', () => {
  const raw = Buffer.concat([Buffer.from('v20'), randomBytes(40)])
  assert.throws(() => decryptV10Cookie(raw, key), (error) => error.code === 'V20')
})

test('deriveAesKey strips the "DPAPI" marker and passes the blob to dpapi', async () => {
  let received = undefined
  const blob = randomBytes(64)
  const encryptedKeyB64 = Buffer.concat([Buffer.from('DPAPI'), blob]).toString('base64')
  const dpapi = async (b64) => {
    received = Buffer.from(b64, 'base64')
    return key
  }
  const result = await deriveAesKey(encryptedKeyB64, { dpapi })
  assert.equal(result, key)
  assert.deepEqual(received, blob)
})

test('deriveAesKey rejects a missing marker and a short key', async () => {
  const bogus = Buffer.concat([Buffer.from('NOPE!'), randomBytes(40)]).toString('base64')
  await assert.rejects(() => deriveAesKey(bogus, { dpapi: async () => key }), (e) => e.code === 'BAD_KEY')
  const short = Buffer.concat([Buffer.from('DPAPI'), randomBytes(40)]).toString('base64')
  await assert.rejects(() => deriveAesKey(short, { dpapi: async () => randomBytes(16) }), (e) => e.code === 'BAD_KEY')
})

test('buildSessionCookie decrypts and joins Yuque cookies', () => {
  const rows = [
    { host_key: '.yuque.com', name: '_yuque_session', encrypted_value: encryptV10('SESSION123', key) },
    { host_key: '.yuque.com', name: 'cookieToken', encrypted_value: encryptV10('CSRF456', key) },
    { host_key: '.yuque.com', name: 'lang', encrypted_value: encryptV10('zh-cn', key) },
  ]
  const built = buildSessionCookie(rows, key)
  assert.equal(built.session, 'SESSION123')
  assert.equal(built.csrf, 'CSRF456')
  assert.equal(built.cookie, '_yuque_session=SESSION123; cookieToken=CSRF456')
})

test('buildSessionCookie strips the per-domain binding from each cookie', () => {
  const host = '.yuque.com'
  const digest = createHash('sha256').update(host).digest()
  const rows = [
    { host_key: host, name: '_yuque_session', encrypted_value: encryptV10('REAL-SESSION', key, { prefix: digest }) },
    { host_key: host, name: 'cookieToken', encrypted_value: encryptV10('REAL-CSRF', key, { prefix: digest }) },
  ]
  const built = buildSessionCookie(rows, key)
  assert.equal(built.cookie, '_yuque_session=REAL-SESSION; cookieToken=REAL-CSRF')
})

test('buildSessionCookie prefers ctoken when both spellings are present', () => {
  const rows = [
    { name: '_yuque_session', encrypted_value: encryptV10('s', key) },
    { name: 'ctoken', encrypted_value: encryptV10('c1', key) },
    { name: 'cookieToken', encrypted_value: encryptV10('c2', key) },
  ]
  const built = buildSessionCookie(rows, key)
  assert.equal(built.cookie, '_yuque_session=s; ctoken=c1')
})

test('buildSessionCookie throws when the session is missing', () => {
  assert.throws(
    () => buildSessionCookie([{ name: 'lang', encrypted_value: encryptV10('zh-cn', key) }], key),
    (error) => error.code === 'NO_SESSION',
  )
})

test('findEdgePath returns the first candidate that exists', () => {
  const candidates = ['C:/a/msedge.exe', 'C:/b/msedge.exe']
  assert.equal(
    findEdgePath({ candidates, exists: (p) => p === 'C:/b/msedge.exe' }),
    'C:/b/msedge.exe',
  )
})

test('findEdgePath throws NO_EDGE when nothing exists', () => {
  assert.throws(
    () => findEdgePath({ candidates: ['C:/nope/msedge.exe'], exists: () => false }),
    (error) => error.code === 'NO_EDGE',
  )
})

test('waitForPidExit resolves as soon as the process is reported dead', async () => {
  await waitForPidExit(1234, { isAlive: () => false, sleepMs: 1 })
})

test('waitForPidExit waits through a transiently alive process then returns', async () => {
  let alive = true
  let polls = 0
  const isAlive = () => {
    polls += 1
    if (polls >= 3) alive = false
    return alive
  }
  await waitForPidExit(99, { isAlive, sleepMs: 1 })
  assert.equal(polls, 3)
})

test('waitForPidExit throws TIMEOUT when the process never dies', async () => {
  await assert.rejects(
    () => waitForPidExit(55, { isAlive: () => true, sleepMs: 1, timeoutMs: 20 }),
    (error) => error.code === 'TIMEOUT',
  )
})