/**
 * Minimal Yuque (语雀) API v2 client used by the yuque-notes plugin.
 *
 * The only dependency is the platform `fetch`, so the module stays importable
 * from a profile-installed bundle without resolving any DSH package.
 *
 * Endpoints used:
 *   GET  /user                           -> the token owner (login)
 *   GET  /users/{login}/repos?type=Book   -> knowledge bases the account can see
 *   POST /repos/{namespace}/docs          -> create a Markdown document
 */

export const DEFAULT_API_BASE = 'https://www.yuque.com/api/v2'

/** A Yuque API failure with the HTTP status and Yuque's own message. */
export class YuqueError extends Error {
  /**
   * @param {string} message - human readable failure, already in the user's language.
   * @param {{ status?: number, code?: string }} [details] - HTTP status and a stable code.
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'YuqueError'
    this.status = details.status
    this.code = details.code
  }
}

/** Render the public URL of a document inside one knowledge base. */
export function documentUrl(namespace, slug) {
  return `https://www.yuque.com/${namespace}/${slug}`
}

/** Encode each segment of a `login/book-slug` namespace for use in a path. */
function encodeNamespace(namespace) {
  return namespace.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

/**
 * Perform one authenticated Yuque API call.
 *
 * Two credential shapes are accepted: an Open API `token` (sent as
 * `X-Auth-Token`) or a web `cookie` (sent as `Cookie`). The cookie form also
 * needs Yuque's CSRF value in `x-csrf-token` for writes.
 *
 * @param {object} options - request description.
 * @param {string} options.apiBase - API root, without a trailing slash.
 * @param {string} [options.token] - personal access token.
 * @param {string} [options.cookie] - browser Cookie header value.
 * @param {string} [options.csrf] - `ctoken` value for web write requests.
 * @param {string} [options.origin] - Origin/Referer base for web write requests.
 * @param {string} options.path - path below the API root, already encoded.
 * @param {string} [options.method] - HTTP method, default GET.
 * @param {Record<string, string | number>} [options.query] - query parameters.
 * @param {unknown} [options.body] - JSON body.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @param {typeof fetch} [options.fetchImpl] - injection point for tests.
 * @returns {Promise<any>} the parsed JSON payload.
 */
export async function request({
  apiBase = DEFAULT_API_BASE,
  token,
  cookie,
  csrf,
  origin,
  path,
  method = 'GET',
  query,
  body,
  signal,
  fetchImpl = globalThis.fetch,
} = {}) {
  const hasToken = typeof token === 'string' && token.trim().length > 0
  const hasCookie = typeof cookie === 'string' && cookie.trim().length > 0
  if (!hasToken && !hasCookie) {
    throw new YuqueError('没有可用的语雀凭据：请先运行 /yuque-token <Token> 或 /yuque-login 配置。', {
      code: 'TOKEN_MISSING',
    })
  }
  if (typeof fetchImpl !== 'function') {
    throw new YuqueError('当前运行环境没有 fetch，无法访问语雀 API。', { code: 'NO_FETCH' })
  }
  const url = new URL(`${apiBase.replace(/\/+$/, '')}${path}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'dsh-plugin-yuque-notes/0.1.0',
  }
  if (hasCookie) headers.Cookie = cookie
  if (hasToken) headers['X-Auth-Token'] = token
  if (typeof csrf === 'string' && csrf.length > 0) headers['x-csrf-token'] = csrf
  if (typeof origin === 'string' && origin.length > 0) {
    headers.Origin = origin
    headers.Referer = `${origin}/`
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let response
  try {
    response = await fetchImpl(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new YuqueError(`无法连接语雀（${error?.message ?? error}）。请检查网络或代理设置。`, { code: 'NETWORK' })
  }

  const text = await response.text()
  let payload = undefined
  if (text.length > 0) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = undefined
    }
  }
  if (!response.ok) {
    const detail = payload?.message ?? (text.length > 0 ? text.slice(0, 300) : response.statusText)
    throw new YuqueError(`语雀接口返回 ${response.status}：${detail}`, {
      status: response.status,
      code: statusCode(response.status),
    })
  }
  if (payload === undefined) {
    throw new YuqueError('语雀接口返回了无法解析的内容。', { status: response.status, code: 'BAD_PAYLOAD' })
  }
  return payload
}

/** Stable diagnosis code for one HTTP status. */
function statusCode(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return 'HTTP'
}

/**
 * Read the account the token belongs to.
 * @returns {Promise<{ login: string, name?: string, id?: number }>} the token owner.
 */
export async function getCurrentUser(options) {
  const payload = await request({ ...options, path: '/user' })
  const user = payload?.data
  if (user === undefined || typeof user.login !== 'string' || user.login.length === 0) {
    throw new YuqueError('无法读取语雀账号信息，请确认 Token 有效。', { code: 'BAD_PAYLOAD' })
  }
  return user
}

/**
 * List the knowledge bases visible to an account.
 * @returns {Promise<Array<{ id: number, name: string, namespace: string, slug: string }>>} books.
 */
export async function listBooks(options, login) {
  const payload = await request({
    ...options,
    path: `/users/${encodeURIComponent(login)}/repos`,
    query: { type: 'Book' },
  })
  const books = Array.isArray(payload?.data) ? payload.data : []
  return books.filter((book) => typeof book?.namespace === 'string' && book.namespace.includes('/'))
}

/**
 * Resolve the knowledge base a new document is written into.
 *
 * A configured namespace wins; otherwise the first book of the account is used,
 * which is what "the default knowledge base" means for most personal accounts.
 *
 * @param {object} options - client options plus `preferred`.
 * @param {string} [options.preferred] - configured `login/book-slug` namespace.
 * @returns {Promise<{ namespace: string, books: Array<object> }>} the target namespace.
 */
export async function resolveBook(options, preferred) {
  const wanted = typeof preferred === 'string' ? preferred.trim() : ''
  if (wanted.length > 0) {
    if (!wanted.includes('/')) {
      throw new YuqueError(`知识库 namespace "${wanted}" 格式不对，应为 "login/book-slug"。`, { code: 'BAD_NAMESPACE' })
    }
    return { namespace: wanted, books: [] }
  }
  const user = await getCurrentUser(options)
  const books = await listBooks(options, user.login)
  const first = books[0]
  if (first === undefined) {
    throw new YuqueError(
      '这个语雀账号下没有可用的知识库。请先在语雀里创建一个知识库，或在插件配置里填写 book（形如 "login/book-slug"）。',
      { code: 'NO_BOOK' },
    )
  }
  return { namespace: first.namespace, books }
}

/**
 * Create one Markdown document.
 * @param {object} options - client options plus the document fields.
 * @param {string} options.namespace - `login/book-slug`.
 * @param {string} options.title - document title.
 * @param {string} options.markdown - document body in Markdown.
 * @param {boolean} [options.publicDoc] - whether the document is public.
 * @param {string} [options.slug] - explicit document slug.
 * @returns {Promise<{ id: number, slug: string, title: string, namespace: string, url: string }>} the created document.
 */
export async function createDoc({ namespace, title, markdown, publicDoc = false, slug, ...options }) {
  if (typeof namespace !== 'string' || !namespace.includes('/')) {
    throw new YuqueError(`知识库 namespace "${String(namespace)}" 格式不对，应为 "login/book-slug"。`, { code: 'BAD_NAMESPACE' })
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new YuqueError('文档标题不能为空。', { code: 'BAD_TITLE' })
  }
  const body = {
    title: title.trim(),
    body: markdown,
    body_format: 'markdown',
    public: publicDoc ? 1 : 0,
  }
  if (typeof slug === 'string' && slug.trim().length > 0) body.slug = slug.trim()
  const payload = await request({
    ...options,
    method: 'POST',
    path: `/repos/${encodeNamespace(namespace)}/docs`,
    body,
  })
  const doc = payload?.data
  if (doc === undefined || typeof doc.slug !== 'string') {
    throw new YuqueError('语雀没有返回新文档信息，请到语雀中确认是否已创建。', { code: 'BAD_PAYLOAD' })
  }
  return {
    id: doc.id,
    slug: doc.slug,
    title: doc.title ?? title.trim(),
    namespace,
    url: documentUrl(namespace, doc.slug),
  }
}

// ---------------------------------------------------------------------------
// Web session mode: the browser login state, for accounts without API tokens.
// ---------------------------------------------------------------------------

/** Base of Yuque's web application (the cookie-authenticated endpoints). */
export const WEB_BASE = 'https://www.yuque.com'

/**
 * Split a pasted browser cookie into the Cookie header and the CSRF token.
 *
 * Accepts the raw `name=value; name=value` line, or that line prefixed with
 * `Cookie:` as copied from the browser's request headers.
 *
 * @param {string} raw - pasted cookie text.
 * @returns {{ cookie: string, csrf: string | undefined }} normalized values.
 */
export function parseSessionCookie(raw) {
  const text = String(raw ?? '')
    .replace(/^\s*cookie\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length === 0) {
    throw new YuqueError('Cookie 为空：请把浏览器里 yuque.com 的 Cookie 整行粘贴进来。', { code: 'EMPTY_COOKIE' })
  }
  // Yuque has shipped both spellings for the CSRF value over time.
  const csrf = /(?:^|;\s*)ctoken=([^;]+)/.exec(text)?.[1]
    ?? /(?:^|;\s*)cookieToken=([^;]+)/.exec(text)?.[1]
  return { cookie: text, csrf }
}

/**
 * Read the signed-in account of a web session.
 * @returns {Promise<{ login: string, name?: string, id?: number }>} the account.
 */
export async function getSessionAccount({ cookie, fetchImpl = globalThis.fetch, signal } = {}) {
  const payload = await request({
    apiBase: WEB_BASE,
    cookie,
    path: '/api/mine',
    fetchImpl,
    signal,
  })
  const user = payload?.data ?? payload
  if (user === undefined || typeof user.login !== 'string' || user.login.length === 0) {
    throw new YuqueError('无法读取语雀登录账号，Cookie 可能已失效，请重新登录后复制。', { code: 'BAD_PAYLOAD' })
  }
  return user
}

/**
 * List the knowledge bases of a web session.
 * @returns {Promise<Array<{ id: number, name: string, slug?: string }>>} books.
 */
export async function listSessionBooks({ cookie, fetchImpl = globalThis.fetch, signal } = {}) {
  const payload = await request({
    apiBase: WEB_BASE,
    cookie,
    path: '/api/mine/books',
    fetchImpl,
    signal,
  })
  const books = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return books.filter((book) => book !== null && typeof book === 'object' && book.id !== undefined)
}

// ---------------------------------------------------------------------------
// Catalog (知识库目录) helpers: list a book's 目录 tree and resolve a folder node.
// ---------------------------------------------------------------------------

/**
 * Normalize raw 目录节点 into a tolerant shape. Yuque returns nodes with
 * numeric `id` and/or string `uuid`, and links them with `parent_id` /
 * `parent_uuid` (or camelCase in some shapes). Only the fields we need survive.
 */
function normalizeTocNodes(raw) {
  const list = Array.isArray(raw) ? raw : []
  return list
    .filter((node) => node !== null && typeof node === 'object')
    .map((node) => ({
      id: typeof node.id === 'number' || typeof node.id === 'string' ? node.id : undefined,
      uuid: typeof node.uuid === 'string' ? node.uuid : undefined,
      title: node.title ?? node.name ?? node.doc_title ?? '',
      parentId: node.parent_id ?? node.parentId,
      parentUuid: node.parent_uuid ?? node.parentUuid,
      depth: node.depth ?? node.level,
    }))
    .filter((node) => String(node.title).length > 0 || node.id !== undefined || node.uuid !== undefined)
}

/** Empty means "root level" for a parent pointer. */
function emptyLink(value) {
  return value === undefined || value === null || value === '' || value === 0
}

/** Direct children of one node, matched by either id or uuid linkage. */
function childrenOf(nodes, parent) {
  const uuid = parent?.uuid
  const id = parent?.id
  if ((uuid === undefined || uuid === '') && (id === undefined || id === '')) return []
  return nodes.filter((node) => (uuid !== undefined && node.parentUuid === uuid) || (id !== undefined && node.parentId === id))
}

/**
 * Read the 目录 tree of a knowledge base through the Open API (token mode).
 * @returns {Promise<Array<{ id?: number|string, uuid?: string, title: string, parentId?, parentUuid?, depth? }>>}
 */
export async function listToc({ apiBase = DEFAULT_API_BASE, token, namespace, fetchImpl, signal } = {}) {
  const payload = await request({
    apiBase,
    token,
    path: `/repos/${encodeNamespace(namespace)}/toc`,
    fetchImpl,
    signal,
  })
  return normalizeTocNodes(Array.isArray(payload?.data) ? payload.data : payload)
}

/**
 * Read the 目录 tree of a knowledge base through the web session (cookie mode).
 * @returns {Promise<Array<{ id?: number|string, uuid?: string, title: string, parentId?, parentUuid?, depth? }>>}
 */
export async function listSessionToc({ cookie, bookId, fetchImpl = globalThis.fetch, signal } = {}) {
  const payload = await request({
    apiBase: WEB_BASE,
    cookie,
    path: `/api/books/${encodeURIComponent(String(bookId))}/toc`,
    fetchImpl,
    signal,
  })
  return normalizeTocNodes(Array.isArray(payload?.data) ? payload.data : payload)
}

/**
 * Resolve a 目录 folder node from its title or a slash-separated path
 * (e.g. "复盘" or "工作/复盘"). Exact full-title match wins; a single segment
 * falls back to case-insensitive match; a multi-segment path walks the parent
 * links. Returns the matching node, or `undefined` when not found.
 */
export function resolveCatalogNode(nodes, wanted) {
  const target = String(wanted ?? '').trim()
  if (target.length === 0) return undefined
  const segments = target.replace(/\/+/g, '/').replace(/^\/|\/$/g, '').split('/').filter(Boolean)
  const exact = nodes.find((node) => String(node.title ?? '').trim() === target)
  if (exact !== undefined) return exact
  if (segments.length === 1) {
    const name = segments[0].toLowerCase()
    const hit = nodes.find((node) => String(node.title ?? '').trim().toLowerCase() === name)
    return hit
  }
  // Path walk: start from root nodes, descend one title segment at a time.
  let level = nodes.filter((node) => emptyLink(node.parentId) && emptyLink(node.parentUuid))
  if (level.length === 0) level = nodes.filter((node) => node.depth === 0)
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i].toLowerCase()
    const hit = level.find((node) => String(node.title ?? '').trim().toLowerCase() === seg)
    if (hit === undefined) return undefined
    if (i === segments.length - 1) return hit
    level = childrenOf(nodes, hit)
    if (level.length === 0) return undefined
  }
  return undefined
}

/**
 * Create a Markdown document through the web session API.
 *
 * The web endpoint needs both the session Cookie and the `ctoken` CSRF value,
 * plus Origin/Referer headers, which is why this request passes all three.
 *
 * @param {object} options - session credentials and document fields.
 * @param {string} options.cookie - Cookie header value.
 * @param {string} options.csrf - `ctoken` value.
 * @param {number} options.bookId - numeric knowledge base id.
 * @param {string} options.namespace - `login/book-slug`, used for the returned URL.
 * @param {string} options.title - document title.
 * @param {string} options.markdown - document body in Markdown.
 * @param {boolean} [options.publicDoc] - whether the document is public.
 * @param {string} [options.slug] - explicit document slug.
 * @param {number|string} [options.parentId] - id of the 目录 folder node to place the doc under.
 * @param {string} [options.parentUuid] - uuid of the 目录 folder node (used when only a uuid is known).
 * @returns {Promise<{ id: number, slug: string, title: string, namespace: string, url: string }>} the created document.
 */
export async function createSessionDoc({
  cookie,
  csrf,
  bookId,
  namespace,
  title,
  markdown,
  publicDoc = false,
  slug,
  parentId,
  parentUuid,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (bookId === undefined || bookId === null) {
    throw new YuqueError('缺少知识库 id，无法创建文档。', { code: 'NO_BOOK_ID' })
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new YuqueError('文档标题不能为空。', { code: 'BAD_TITLE' })
  }
  const body = {
    book_id: bookId,
    title: title.trim(),
    body: markdown,
    body_format: 'markdown',
    public: publicDoc ? 1 : 0,
    insert_to_catalog: true,
  }
  if (typeof slug === 'string' && slug.trim().length > 0) body.slug = slug.trim()
  if (parentId !== undefined && parentId !== null && String(parentId).length > 0) body.parent_id = parentId
  else if (parentUuid !== undefined && parentUuid !== null && parentUuid.length > 0) body.parent_uuid = parentUuid
  const payload = await request({
    apiBase: WEB_BASE,
    cookie,
    csrf,
    origin: WEB_BASE,
    method: 'POST',
    path: '/api/docs',
    body,
    fetchImpl,
    signal,
  })
  const doc = payload?.data ?? payload
  if (doc === undefined || typeof doc?.slug !== 'string') {
    throw new YuqueError('语雀没有返回新文档信息，请到语雀中确认是否已创建。', { code: 'BAD_PAYLOAD' })
  }
  return {
    id: doc.id,
    slug: doc.slug,
    title: doc.title ?? title.trim(),
    namespace,
    url: documentUrl(namespace, doc.slug),
  }
}