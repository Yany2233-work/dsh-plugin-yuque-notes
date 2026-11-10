/**
 * Browser-assisted Yuque login capture.
 *
 * Flow (used when the user has no API token and no pasted Cookie yet):
 *   launch an isolated Edge instance with a throwaway user-data-dir, let the
 *   user sign into Yuque and close the window, then read the fresh profile's
 *   Cookies database and decrypt `_yuque_session` (+ `cookieToken`/`ctoken`).
 *
 * This library is plain Node + Windows tooling; it imports no DSH package so it
 * stays unit-testable in the unpacked package.
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { YuqueError } from './yuque-client.js'

export const YUQUE_LOGIN_URL = 'https://www.yuque.com/login'

/** Browser binaries tried in order; the first that exists wins. */
export function defaultEdgeCandidates(env = process.env) {
  const list = []
  for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)']]) {
    if (root) list.push(`${root}\\Microsoft\\Edge\\Application\\msedge.exe`)
  }
  list.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
  list.push('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe')
  return [...new Set(list.filter(Boolean))]
}

/** Return the first existing Edge executable, or throw a user-facing error. */
export function findEdgePath({ candidates = defaultEdgeCandidates(), exists = fs.existsSync } = {}) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && exists(candidate)) return candidate
  }
  throw new YuqueError('未找到 Microsoft Edge，无法自动打开登录页；请改用 /yuque-login <浏览器Cookie> 手动粘贴。', {
    code: 'NO_EDGE',
  })
}

/** Create a throwaway profile directory under the OS temp area. */
export function createTempProfile({ fsImpl = fs, osImpl = os, pathImpl = path, prefix = 'yuque-login-' } = {}) {
  const dir = pathImpl.join(osImpl.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fsImpl.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Launch an isolated Edge window at the Yuque login page and return the browser
 * process id. stdio is ignored so the caller never blocks on it.
 */
export function launchEdge({ edgePath, userDataDir, url = YUQUE_LOGIN_URL, spawnImpl = spawn } = {}) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]
  const child = spawnImpl(edgePath, [...args, url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref?.()
  return child.pid
}

/**
 * DPAPI-decrypt one base64 blob with Windows' ProtectedData (CurrentUser scope).
 * Returns the plaintext as a Buffer. Injectable for tests.
 */
export function dpapiUnprotectWindows(b64, { spawnImpl = spawn } = {}) {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    '$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Write([Convert]::ToBase64String($p))',
  ].join('; ')
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    )
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new YuqueError(`DPAPI 解密失败（退出码 ${code}），请改用手动粘贴 Cookie。`, { code: 'DPAPI' }))
      else resolve(Buffer.from(Buffer.concat(chunks).toString('utf8').trim(), 'base64'))
    })
    child.stdin.end(b64)
  })
}

/**
 * Derive the AES-256 key Chromium uses for `v10` cookies from the Local State
 * `os_crypt.encrypted_key` value: base64("DPAPI" + DPAPI(32-byte key)).
 *
 * @param {string} encryptedKeyB64 - value straight from Local State.
 * @param {(b64: string) => Buffer | Promise<Buffer>} dpapi - DPAPI decrypt.
 */
export async function deriveAesKey(encryptedKeyB64, { dpapi = dpapiUnprotectWindows } = {}) {
  const blob = Buffer.from(encryptedKeyB64, 'base64')
  if (blob.length < 6 || blob.subarray(0, 5).toString('latin1') !== 'DPAPI') {
    throw new YuqueError('浏览器加密密钥格式不识别，无法解密登录态。', { code: 'BAD_KEY' })
  }
  const key = await dpapi(blob.subarray(5).toString('base64'))
  if (!key || key.length !== 32) {
    throw new YuqueError('浏览器加密密钥解密失败，请改用手动粘贴 Cookie。', { code: 'BAD_KEY' })
  }
  return key
}

/**
 * Decrypt one Chromium `v10` cookie value: `"v10"` + 12-byte nonce + AES-GCM.
 *
 * Chromium 139+ prepends `SHA-256(host_key)` to the plaintext before encrypting
 * (a per-domain binding), so when `hostKey` is supplied and the plaintext starts
 * with that digest, the 32 digest bytes are stripped to yield the real value.
 * Older profiles without the binding decrypt to the value directly.
 *
 * @param {Uint8Array | Buffer} raw - the `encrypted_value` column.
 * @param {Buffer} key - the 32-byte AES key.
 * @param {{ hostKey?: string }} [options] - the cookie's host_key column, for binding stripping.
 * @returns {string} the plaintext cookie value ('' for empty cookies).
 */
export function decryptV10Cookie(raw, key, { hostKey } = {}) {
  const buf = Buffer.from(raw)
  if (buf.length < 3 || buf.subarray(0, 3).toString('latin1') !== 'v10') {
    throw new YuqueError('浏览器 Cookie 不是 v10 加密，无法自动解密，请改用手动粘贴。', { code: 'V20' })
  }
  if (buf.length < 3 + 12 + 16) {
    throw new YuqueError('浏览器 Cookie 数据不完整，请改用手动粘贴。', { code: 'BAD_COOKIE' })
  }
  const nonce = buf.subarray(3, 15)
  const ciphertext = buf.subarray(15)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  // Strip a leading per-domain SHA-256 binding when present.
  if (typeof hostKey === 'string' && hostKey.length > 0 && plain.length >= 32) {
    const digest = createHash('sha256').update(hostKey, 'utf8').digest()
    if (plain.subarray(0, 32).equals(digest)) {
      return plain.subarray(32).toString('utf8')
    }
  }
  return plain.toString('utf8')
}

/** Read `os_crypt.encrypted_key` from the profile's Local State. */
export function readLocalStateKey(userDataDir, { fsImpl = fs } = {}) {
  const text = fsImpl.readFileSync(path.join(userDataDir, 'Local State'), 'utf8')
  const localState = JSON.parse(text)
  const key = localState?.os_crypt?.encrypted_key
  if (typeof key !== 'string' || key.length === 0) {
    throw new YuqueError('浏览器配置文件里没有可用的加密密钥。', { code: 'BAD_KEY' })
  }
  return key
}

/**
 * Read cookie rows from a Chromium Cookies SQLite database.
 * @param {string} dbPath - path to the Cookies database.
 * @param {{ DatabaseSync?: Function }} [sqlite] - injectable; defaults to node:sqlite.
 * @returns {Promise<Array<{ host_key: string, name: string, encrypted_value: Uint8Array }>>}
 */
export async function readCookieRows(dbPath, { sqlite } = {}) {
  let DatabaseSync = sqlite?.DatabaseSync
  if (typeof DatabaseSync !== 'function') {
    try {
      ;({ DatabaseSync } = await import('node:sqlite'))
    } catch {
      throw new YuqueError('当前环境不支持读取浏览器 Cookie（node:sqlite 不可用），请改用手动粘贴。', {
        code: 'NO_SQLITE',
      })
    }
  }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db
      .prepare("select host_key, name, encrypted_value from cookies where host_key like '%yuque.com%'")
      .all()
  } finally {
    db.close()
  }
}

/**
 * Decrypt the Yuque session cookies and build the Cookie header line.
 * @returns {{ cookie: string, session: string, csrf: string | undefined }}
 */
export function buildSessionCookie(rows, key) {
  const wanted = new Set(['_yuque_session', 'ctoken', 'cookieToken'])
  const byName = new Map()
  for (const row of rows) {
    if (!wanted.has(row.name) || byName.has(row.name)) continue
    byName.set(row.name, decryptV10Cookie(row.encrypted_value, key, { hostKey: row.host_key }))
  }
  const session = byName.get('_yuque_session')
  if (typeof session !== 'string' || session.length === 0) {
    throw new YuqueError('浏览器里没有找到语雀的登录 Cookie，可能没有登录成功。', { code: 'NO_SESSION' })
  }
  const parts = [`_yuque_session=${session}`]
  let csrf
  if (byName.has('ctoken')) {
    csrf = byName.get('ctoken')
    if (csrf) parts.push(`ctoken=${csrf}`)
  } else if (byName.has('cookieToken')) {
    csrf = byName.get('cookieToken')
    if (csrf) parts.push(`cookieToken=${csrf}`)
  }
  return { cookie: parts.join('; '), session, csrf }
}

/** Poll a read on `dbPath` until the owning browser releases it, or timeout. */
export async function waitUntilReadable(dbPath, { timeoutMs = 180_000, readCookieRowsImpl = readCookieRows } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  for (;;) {
    try {
      return await readCookieRowsImpl(dbPath)
    } catch (error) {
      lastError = error
      if (Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, 1200))
    }
  }
  throw new YuqueError(
    `等待浏览器登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）。登录后请关闭窗口；仍未成功时改用 /yuque-login <Cookie>。`,
    { code: 'TIMEOUT', cause: lastError },
  )
}

/** Tells whether a process is currently alive; `process.kill(pid, 0)` is the probe. */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Wait until the launched browser process exits (the user closed the window).
 * This is the authoritative "login is over" signal: the cookie DB is only read
 * afterwards, so a still-open login page never yields a premature guest session.
 */
export async function waitForPidExit(pid, { timeoutMs = 180_000, isAlive = isPidAlive, sleepMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!isAlive(pid)) return
    if (Date.now() > deadline) {
      throw new YuqueError(
        `等待浏览器登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）。登录后请关闭窗口；仍未成功时改用 /yuque-login <Cookie>。`,
        { code: 'TIMEOUT' },
      )
    }
    await new Promise((resolve) => setTimeout(resolve, sleepMs))
  }
}