/**
 * dsh-plugin-yuque-notes
 *
 * Distill the running conversation into a Yuque document and file it into the
 * signed-in Yuque account.
 *
 * Two credential shapes are supported, because Yuque's Open API token requires a
 * paid plan while a normal website login does not:
 *
 *   /yuque-token <token>     Open API token (X-Auth-Token)
 *   /yuque-login <cookie>    browser Cookie line copied from yuque.com
 *   /yuque-account           show the signed-in Yuque account
 *   /yuque-book [filter]     show status / list the account's knowledge bases
 *   /yuque-save [title]      ask the agent to distill this conversation, then upload
 *   yuque_save               the model-facing tool that performs the upload
 *
 * The plugin imports no DSH package on purpose: a profile-installed bundle then
 * needs no peer resolution, and the same file can be smoke-tested in plain Node.
 */

import {
  DEFAULT_API_BASE,
  YuqueError,
  createDoc,
  createSessionDoc,
  getCurrentUser,
  getSessionAccount,
  listBooks,
  listSessionBooks,
  listSessionToc,
  listToc,
  parseSessionCookie,
  resolveCatalogNode,
} from './lib/yuque-client.js'
import {
  buildSessionCookie,
  createTempProfile,
  deriveAesKey,
  findEdgePath,
  launchEdge,
  readLocalStateKey,
  waitForPidExit,
  waitUntilReadable,
} from './lib/browser-login.js'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const name = 'yuque-notes'

/** Services this plugin needs; it stays inactive in profiles without them. */
export const inject = ['commands', 'tools', 'credentials']

/** Credential references: Open API token, or the browser Cookie line. */
const TOKEN_REF = 'YUQUE_TOKEN'
const SESSION_REF = 'YUQUE_SESSION'

/** Command line usage text shared by the command handlers. */
const USAGE = [
  '/yuque-login          自动打开浏览器登录语雀并抓取登录态（免会员，推荐）',
  '/yuque-login <Cookie> 手动粘贴浏览器 Cookie（含 _yuque_session 与 ctoken/cookieToken）',
  '/yuque-token <Token>  保存语雀开放 API Token（需会员）',
  '/yuque-account        显示当前语雀登录账号',
  '/yuque-book [筛选词]  查看状态；给出筛选词时列出账号下的知识库',
  '/yuque-dir  [筛选词]  列出目标知识库的目录，供选择保存位置',
  '/yuque-save [标题] [@目录]   把本次对话提炼成笔记并上传到语雀，可指定保存目录（如 /yuque-save 复盘 @工作/复盘）',
].join('\n')

/** Resolve the effective plugin settings, applying environment fallbacks. */
function settings(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const pick = (value, fallback) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback)
  return {
    apiBase: pick(raw.apiBase, process.env.YUQUE_API_BASE?.trim() || DEFAULT_API_BASE),
    book: typeof raw.book === 'string' ? raw.book.trim() : (process.env.YUQUE_BOOK?.trim() || ''),
    catalog: typeof raw.catalog === 'string' ? raw.catalog.trim() : (process.env.YUQUE_CATALOG?.trim() || ''),
    publicDoc: raw.public === true || raw.public === 1 || raw.public === '1',
    token: pick(raw.token, process.env.YUQUE_TOKEN?.trim() || ''),
    cookie: pick(raw.cookie, process.env.YUQUE_COOKIE?.trim() || ''),
    edgePath: pick(raw.edgePath, ''),
    loginTimeoutMs: typeof raw.loginTimeoutMs === 'number' ? raw.loginTimeoutMs : 180_000,
  }
}

/**
 * Read one secret, preferring an explicit config value, then the DSH credential
 * store, then the environment.
 * @returns {Promise<string | undefined>} the value, or undefined when unset.
 */
async function resolveSecret(ctx, configured, ref) {
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  try {
    const hit = await ctx.credentials.resolve(ref)
    const value = typeof hit?.value === 'string' ? hit.value.trim() : ''
    if (value.length > 0) return value
  } catch {
    // A missing or unreadable credential store falls through to "not configured".
  }
  return undefined
}

/**
 * Resolve which credential the plugin should use: an Open API token wins,
 * otherwise the stored browser session.
 * @returns {Promise<object | undefined>} `{ kind: 'token' | 'session', ... }`.
 */
async function authorize(ctx, config) {
  const current = settings(config)
  const token = await resolveSecret(ctx, current.token, TOKEN_REF)
  if (token !== undefined) return { kind: 'token', token }
  const raw = await resolveSecret(ctx, current.cookie, SESSION_REF)
  if (raw !== undefined) {
    const { cookie, csrf } = parseSessionCookie(raw)
    return { kind: 'session', cookie, csrf }
  }
  return undefined
}

/** Read the account behind the active credential. */
async function fetchAccount(auth, current, signal) {
  if (auth.kind === 'token') return getCurrentUser({ apiBase: current.apiBase, token: auth.token, signal })
  return getSessionAccount({ cookie: auth.cookie, signal })
}

/** Read the knowledge bases behind the active credential, normalized. */
async function fetchBooks(auth, current, login, signal) {
  if (auth.kind === 'token') return listBooks({ apiBase: current.apiBase, token: auth.token, signal }, login)
  const books = await listSessionBooks({ cookie: auth.cookie, signal })
  return books.map((book) => ({
    id: book.id,
    name: book.name,
    slug: book.slug,
    namespace: typeof book.namespace === 'string' && book.namespace.includes('/')
      ? book.namespace
      : `${login}/${book.slug ?? book.id}`,
  }))
}

/**
 * Pick the target knowledge base: an explicit config value, else the first book.
 * @returns {{ namespace: string, id?: number }} the target book.
 */
function pickBook(books, preferred) {
  const wanted = typeof preferred === 'string' ? preferred.trim() : ''
  if (wanted.length > 0) {
    const hit = books.find((book) => book.namespace === wanted || book.slug === wanted || book.name === wanted)
    if (hit !== undefined) return { namespace: hit.namespace, id: hit.id }
    if (wanted.includes('/')) return { namespace: wanted }
    throw new YuqueError(`没有找到知识库“${wanted}”，运行 /yuque-book 查看可用列表。`, { code: 'NO_BOOK' })
  }
  const first = books[0]
  if (first === undefined) {
    throw new YuqueError(
      '这个语雀账号下没有可用的知识库。请先在语雀里创建一个知识库，或在插件配置里填写 book。',
      { code: 'NO_BOOK' },
    )
  }
  return { namespace: first.namespace, id: first.id }
}

/** Read the 目录 tree of the target knowledge base. */
async function fetchCatalog(auth, current, target, signal) {
  if (auth.kind === 'token') {
    return listToc({ apiBase: current.apiBase, token: auth.token, namespace: target.namespace, signal })
  }
  return listSessionToc({ cookie: auth.cookie, bookId: target.id, signal })
}

/**
 * Resolve the 目录 folder node to save into, or `undefined` for the book root.
 * @returns {{ id?: number|string, uuid?: string, title: string } | undefined}
 */
function pickCatalog(nodes, preferred) {
  const wanted = typeof preferred === 'string' ? preferred.trim() : ''
  if (wanted.length === 0) return undefined
  const hit = resolveCatalogNode(nodes, wanted)
  if (hit === undefined) {
    throw new YuqueError(`没有找到目录“${wanted}”，运行 /yuque-dir 查看可用目录。`, { code: 'NO_CATALOG' })
  }
  return { id: hit.id, uuid: hit.uuid, title: hit.title }
}

/** Flag spellings accepted for the directory argument of `/yuque-save`. */
const SAVE_CATALOG_FLAGS = ['--catalog', '--dir', '--目录']

/** Strip one pair of matching quotes around a flag value. */
function stripQuotes(value) {
  const text = String(value ?? '').trim()
  return text.length >= 2 && ((text[0] === '"' && text[text.length - 1] === '"') || (text[0] === "'" && text[text.length - 1] === "'"))
    ? text.slice(1, -1).trim()
    : text
}

/** Escape a literal so it can be embedded in a RegExp alternation. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Remove `length` characters starting at `index`, normalising whitespace. */
function removeSpan(text, index, length) {
  return `${text.slice(0, index)} ${text.slice(index + length)}`.replace(/\s+/g, ' ').trim()
}

/**
 * Parse `/yuque-save [标题] [@目录/路径]` into its two free-text fields.
 *
 * The command owns its own syntax, so a directory chosen at save time is marked
 * either as a `@token` shorthand or with a `--catalog`/`--dir`/`--目录` flag.
 * A quoted flag value may contain spaces (paths are normally slash-separated).
 *
 *   /yuque-save 部署复盘                  -> { title: '部署复盘', catalog: '' }
 *   /yuque-save @工作/复盘                -> { title: '', catalog: '工作/复盘' }
 *   /yuque-save 部署复盘 @工作/复盘        -> { title: '部署复盘', catalog: '工作/复盘' }
 *   /yuque-save 部署复盘 --目录 "工作/复盘" -> { title: '部署复盘', catalog: '工作/复盘' }
 *
 * When both a flag and a `@token` are present, the flag wins for the catalog and
 * the `@token` is still removed from the title.
 * @returns {{ title: string, catalog: string }}
 */
export function parseSaveInput(raw) {
  const text = String(raw ?? '').trim()
  let rest = text
  let catalog = ''

  const flagPattern = new RegExp(
    `(?:^|\\s)(${SAVE_CATALOG_FLAGS.map(escapeRegExp).join('|')})(?:\\s+(?:"([^"]*)"|'([^']*)'|(\\S+)))?`,
    'i',
  )
  const flag = flagPattern.exec(rest)
  if (flag !== null) {
    catalog = stripQuotes(flag[2] ?? flag[3] ?? flag[4] ?? '')
    rest = removeSpan(rest, flag.index, flag[0].length)
  }

  const at = /(?:^|\s)@(\S+)/.exec(rest)
  if (at !== null) {
    if (catalog.length === 0) catalog = at[1]
    rest = removeSpan(rest, at.index, at[0].length)
  }

  return { title: rest, catalog: catalog.trim() }
}

/** The prompt that turns the conversation into a note and one tool call. */
function distillPrompt({ title, book, catalog }) {
  const bookPart = book.length > 0 ? `知识库 ${book}` : '默认知识库'
  const place = catalog.length > 0 ? `${bookPart} 的「${catalog}」目录` : `${bookPart} 的根目录`
  const headline = title.length > 0
    ? `标题固定为：${title}。`
    : '标题由你根据内容拟定：名词短语，不超过 30 个字，不要出现“总结”“对话”这类空泛词。'
  return [
    '请把我们到目前为止的对话提炼成一篇可以长期复用的语雀笔记。',
    '',
    '提炼要求：',
    '1. 只保留有沉淀价值的内容：结论、决策与理由、可复用的步骤或命令、代码要点、坑与注意事项、待办事项。',
    '2. 丢掉寒暄、重复确认、工具调试过程和与结论无关的试错叙述。',
    '3. 用 Markdown 组织：一级标题是文档标题；正文先写 2-4 句摘要；随后按主题（不要按时间顺序）分成若干 ## 小节；必要时使用表格、代码块、清单。',
    '4. 不要编造对话里没有的事实或代码；把握不足的点用“待确认”标出。',
    `5. ${headline}`,
    `6. 完成后必须调用 yuque_save 工具，把这篇 Markdown 原文上传到${place}；参数 markdown 里放完整正文，不要只放摘要。${catalog.length > 0 ? `catalog 参数传 "${catalog}"。` : ''}`,
    '7. 只调用一次 yuque_save。工具成功后，用一句中文回复我文档链接；工具失败时说明失败原因，不要假装成功。',
  ].join('\n')
}

/** Build the `yuque_save` tool definition registered into this profile. */
function defineSaveTool(ctx, config) {
  return {
    name: 'yuque_save',
    description: [
      '把一篇整理好的 Markdown 笔记上传到用户已登录的语雀账号，返回文档链接。',
      '仅在用户要求沉淀/保存笔记，或 /yuque-save 让你整理本次对话时调用。',
      'markdown 必须是完整的、可直接发布的正文（不含 front matter）；标题单独放在 title。',
      '一次调用只创建一篇文档；不要重复上传同一篇内容。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: '文档标题，简洁的名词短语，不超过 30 个字。',
        },
        markdown: {
          type: 'string',
          description: '文档正文，完整 Markdown 原文。',
        },
        namespace: {
          type: 'string',
          description: '可选的知识库 namespace 或名称；省略时用插件配置或账号默认知识库。',
        },
        catalog: {
          type: 'string',
          description: '可选的知识库内目录名称或路径（如「复盘」或「工作/复盘」）；省略时写到知识库根目录。仅网页登录态支持。',
        },
        public: {
          type: 'boolean',
          description: '是否公开这篇文档；省略时用插件配置，默认私密。',
        },
      },
      required: ['title', 'markdown'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          namespace: { type: 'string' },
          slug: { type: 'string' },
        },
        required: ['url', 'title', 'namespace', 'slug'],
      },
      render: (_args, value) => [{ type: 'text', text: `已保存到语雀：${value.url}` }],
    },
    async execute(args, exec) {
      const current = settings(config)
      const auth = await authorize(ctx, config)
      if (auth === undefined) {
        throw new Error('还没有语雀凭据：运行 /yuque-login（会自动打开登录页）或 /yuque-token <Token>。')
      }
      const account = await fetchAccount(auth, current, exec.signal)
      const books = await fetchBooks(auth, current, account.login, exec.signal)
      const preferred = typeof args.namespace === 'string' && args.namespace.trim().length > 0
        ? args.namespace.trim()
        : current.book
      const target = pickBook(books, preferred)
      const catalogWanted = typeof args.catalog === 'string' && args.catalog.trim().length > 0
        ? args.catalog.trim()
        : current.catalog
      let parent
      if (catalogWanted.length > 0) {
        if (auth.kind === 'token') {
          throw new YuqueError(
            '开放 API 不支持把文档写入指定目录；请改用 /yuque-login 使用网页登录态，或去掉 catalog 参数写到知识库根目录。',
            { code: 'NO_CATALOG_TOKEN' },
          )
        }
        const nodes = await fetchCatalog(auth, current, target, exec.signal)
        parent = pickCatalog(nodes, catalogWanted)
      }
      const publicDoc = args.public === undefined ? current.publicDoc : args.public === true
      const options = {
        namespace: target.namespace,
        title: args.title,
        markdown: args.markdown,
        publicDoc,
        signal: exec.signal,
      }
      const doc = auth.kind === 'token'
        ? await createDoc({ ...options, apiBase: current.apiBase, token: auth.token })
        : await createSessionDoc({
          ...options,
          cookie: auth.cookie,
          csrf: auth.csrf,
          bookId: target.id,
          parentId: parent?.id,
          parentUuid: parent?.uuid,
        })
      return {
        url: doc.url,
        title: doc.title,
        namespace: doc.namespace,
        slug: doc.slug,
      }
    },
  }
}

/** `/yuque-token <token>`: persist an Open API token in the credential store. */
async function handleToken(ctx, invocation) {
  const token = invocation.rawInput.trim()
  if (token.length === 0) {
    return {
      kind: 'error',
      text: [
        '用法：/yuque-token <你的语雀个人 Token>',
        '在 https://www.yuque.com/settings/tokens 生成（该功能需要语雀会员）；免费账号请改用 /yuque-login。',
      ].join('\n'),
    }
  }
  await ctx.credentials.set(TOKEN_REF, token)
  const user = await getCurrentUser({ token }).catch(() => undefined)
  return {
    kind: 'success',
    text: user === undefined
      ? '已保存语雀 Token，但没能验证它。可以先用 /yuque-account 检查。'
      : `已保存语雀 Token，并验证通过：账号 ${user.name ?? user.login}（${user.login}）。现在可以运行 /yuque-save。`,
  }
}

/** Best-effort kill of the isolated browser and removal of its profile. */
function cleanupProfile(userDataDir, pid) {
  if (pid !== undefined) {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true }).unref?.()
    } catch {
      // The browser may already be gone; removal below is the real cleanup.
    }
  }
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    // Leftover temp profiles are cleaned by the OS eventually.
  }
}

/** Message sent into the conversation once the auto-login completes. */
function followup(ctx, invocation, text) {
  invocation.agent?.followup?.({
    content: [{ type: 'text', text }],
    source: { kind: 'yuque-notes' },
  })
}

/**
 * Background half of the auto-login: wait for the browser window to close (the
 * DB unlocks), read and decrypt the Yuque session, verify it, store it, then
 * report the account through a follow-up message.
 */
async function finishAutoLogin(ctx, invocation, { edgePath, userDataDir, pid, timeoutMs, set } = {}) {
  try {
    // 1. Wait for the user to close the isolated browser window. Only then is
    //    the cookie DB written and unlocked, and the session authenticated.
    await waitForPidExit(pid, { timeoutMs })
    // 2. Read the (now unlocked) cookie DB, with a short retry to let the
    //    WAL checkpoint flush after shutdown.
    const dbPath = path.join(userDataDir, 'Default', 'Network', 'Cookies')
    const rows = await waitUntilReadable(dbPath, { timeoutMs: 15_000 })
    const encryptedKeyB64 = readLocalStateKey(userDataDir)
    const key = await deriveAesKey(encryptedKeyB64)
    const { cookie, csrf } = buildSessionCookie(rows, key)
    const user = await getSessionAccount({ cookie })
    await set(SESSION_REF, cookie)
    followup(
      ctx,
      invocation,
      [
        `已自动获取语雀登录态并验证通过：${user.name ?? user.login}（${user.login}）`,
        csrf === undefined ? '提示：未在浏览器里发现 ctoken / cookieToken；一般不影响写入，若后续写入被拒再手动粘贴一份。' : '现在可以运行 /yuque-save 把对话提炼后保存到语雀。',
      ].join('\n'),
    )
  } catch (error) {
    followup(
      ctx,
      invocation,
      [
        '自动登录没有成功：',
        error instanceof YuqueError ? error.message : (error?.message ?? String(error)),
        '',
        '补救：重新登录语雀后，手动执行 /yuque-login <Cookie>（把 _yuque_session=...; cookieToken=... 整行粘贴）。',
      ].join('\n'),
    )
  } finally {
    cleanupProfile(userDataDir, pid)
  }
}

/**
 * `/yuque-login`:
 *  - with a pasted Cookie → validate and store it (manual path);
 *  - with no argument → open an isolated browser, capture the login, confirm and store.
 */
async function handleLogin(ctx, config, invocation) {
  const raw = invocation.rawInput.trim()
  if (raw.length === 0) return startAutoLogin(ctx, config, invocation)

  let user
  let parsed
  try {
    parsed = parseSessionCookie(raw)
    user = await getSessionAccount({ cookie: parsed.cookie })
  } catch (error) {
    if (error instanceof YuqueError) {
      return {
        kind: 'error',
        text: `网页登录态验证失败：${error.message}\n请确认 Cookie 含 _yuque_session（整行粘贴），或直接运行 /yuque-login 自动登录。`,
      }
    }
    throw error
  }
  await ctx.credentials.set(SESSION_REF, raw)
  return {
    kind: 'success',
    text: [
      `已保存网页登录态并验证通过：${user.name ?? user.login}（${user.login}）`,
      parsed.csrf === undefined
        ? '提示：Cookie 里没有 ctoken/cookieToken，读取能正常工作；少数账号写文档时可能被拒，届时重新复制整行 Cookie 即可。'
        : '现在可以运行 /yuque-save 把对话提炼后保存到语雀。',
    ].join('\n'),
  }
}

/** Open the isolated browser and schedule the background capture. */
function startAutoLogin(ctx, config, invocation) {
  const current = settings(config)
  let edgePath
  try {
    edgePath = current.edgePath.length > 0 ? current.edgePath : findEdgePath()
  } catch (error) {
    return { kind: 'error', text: error.message }
  }
  const userDataDir = createTempProfile()
  let pid
  try {
    pid = launchEdge({ edgePath, userDataDir })
  } catch (error) {
    cleanupProfile(userDataDir, undefined)
    return { kind: 'error', text: `无法启动 Edge：${error?.message ?? error}` }
  }
  // Do not block the command on the login; report progress afterwards.
  finishAutoLogin(ctx, invocation, {
    edgePath,
    userDataDir,
    pid,
    timeoutMs: current.loginTimeoutMs,
    set: ctx.credentials.set.bind(ctx.credentials),
  })
  return {
    kind: 'success',
    text: [
      '已打开一个干净的 Edge 窗口用于登录语雀。',
      '请在窗口里完成登录，然后**关闭该窗口**；插件会立即读取登录态并验证，随后把结果发到这里。',
      `（${Math.round(current.loginTimeoutMs / 1000)} 秒内未完成会提示超时；想取消直接不登录、关闭窗口即可。）`,
    ].join('\n'),
  }
}

/** `/yuque-account`: show the account behind the active credential. */
async function handleAccount(ctx, config) {
  const current = settings(config)
  const auth = await authorize(ctx, config)
  if (auth === undefined) {
    return { kind: 'error', text: `还没有语雀凭据。\n${USAGE}` }
  }
  let account
  let books = []
  try {
    account = await fetchAccount(auth, current, undefined)
    books = await fetchBooks(auth, current, account.login, undefined).catch(() => [])
  } catch (error) {
    if (error instanceof YuqueError) {
      return {
        kind: 'error',
        text: `读取语雀登录账号失败：${error.message}\n凭据可能已失效；网页登录态可在重新登录后用 /yuque-login 更新。`,
      }
    }
    throw error
  }
  const lines = [
    `语雀登录账号：${account.name ?? account.login}（${account.login}）`,
    ...(account.id === undefined ? [] : [`账号 ID：${account.id}`]),
    ...(typeof account.avatar_url === 'string' && account.avatar_url.length > 0 ? [`头像：${account.avatar_url}`] : []),
    `凭据类型：${auth.kind === 'token' ? '开放 API Token' : '网页登录态（Cookie）'}`,
    `可用知识库：${books.length} 个${current.book.length > 0 ? `，默认写入 ${current.book}` : '，写入时自动使用第一个'}`,
    '',
    '运行 /yuque-book list 可查看知识库列表。',
  ]
  return { kind: 'success', text: lines.join('\n') }
}

/** `/yuque-book [filter]`: report status and list usable knowledge bases. */
async function handleBook(ctx, config, invocation) {
  const current = settings(config)
  const auth = await authorize(ctx, config)
  const lines = [
    auth === undefined
      ? '凭据：未配置，先运行 /yuque-login 或 /yuque-token <Token>'
      : `凭据：${auth.kind === 'token' ? '开放 API Token' : '网页登录态（Cookie）'}`,
    current.book.length > 0 ? `默认知识库：${current.book}` : '默认知识库：自动（账号下第一个知识库）',
  ]
  if (auth === undefined) return { kind: 'error', text: lines.join('\n') }
  try {
    const account = await fetchAccount(auth, current, undefined)
    const books = await fetchBooks(auth, current, account.login, undefined)
    const rawFilter = invocation.rawInput.trim().toLowerCase()
    const filter = rawFilter === 'list' ? ''
      : rawFilter
    const matched = filter.length === 0
      ? books
      : books.filter((book) => `${book.namespace} ${book.name ?? ''}`.toLowerCase().includes(filter))
    lines.push(`账号：${account.name ?? account.login}（${account.login}）`, '', `可用知识库（${books.length} 个）：`)
    for (const book of matched.slice(0, 20)) {
      lines.push(`- ${book.namespace}  ${book.name ?? ''}`)
    }
    lines.push('', '把想固定使用的 namespace 或名称填进插件配置的 book 字段即可。')
    return { kind: 'success', text: lines.join('\n') }
  } catch (error) {
    if (error instanceof YuqueError) {
      lines.push('', `读取失败：${error.message}`, '网页登录态失效后，重新登录并运行 /yuque-login。')
      return { kind: 'error', text: lines.join('\n') }
    }
    throw error
  }
}

/** `/yuque-dir [filter]`: list the 目录 tree of the target knowledge base. */
async function handleDir(ctx, config, invocation) {
  const current = settings(config)
  const auth = await authorize(ctx, config)
  if (auth === undefined) {
    return { kind: 'error', text: `还没有语雀凭据。\n${USAGE}` }
  }
  const bookLine = current.book.length > 0 ? `目标知识库：${current.book}` : '目标知识库：自动（账号下第一个）'
  try {
    const account = await fetchAccount(auth, current, undefined)
    const books = await fetchBooks(auth, current, account.login, undefined)
    const target = pickBook(books, current.book)
    const nodes = await fetchCatalog(auth, current, target, undefined)
    const filter = invocation.rawInput.trim().toLowerCase()
    const matched = filter.length === 0
      ? nodes
      : nodes.filter((node) => String(node.title ?? '').toLowerCase().includes(filter))
    const lines = [
      bookLine,
      `目录（${nodes.length} 个节点，缩进表示层级）${auth.kind === 'token' ? '；注意：开放 API 只读，写入指定目录需用 /yuque-login' : ''}：`,
    ]
    for (const node of matched.slice(0, 50)) {
      const depth = typeof node.depth === 'number' ? node.depth : 0
      const indent = '  '.repeat(depth > 0 && depth < 12 ? depth : 0)
      lines.push(`${indent}- ${node.title}`)
    }
    if (matched.length > 50) lines.push('…（其余省略）')
    lines.push('', '运行 /yuque-save 后按目录名说明保存位置，或把目录名填进插件配置的 catalog 字段（如「复盘」或「工作/复盘」）。')
    return { kind: 'success', text: lines.join('\n') }
  } catch (error) {
    if (error instanceof YuqueError) {
      return { kind: 'error', text: `${bookLine}\n读取目录失败：${error.message}` }
    }
    throw error
  }
}

/** `/yuque-save [title] [@catalog]`: hand the distillation job to the running agent. */
async function handleSave(ctx, config, invocation) {
  const current = settings(config)
  const auth = await authorize(ctx, config)
  if (auth === undefined) {
    return { kind: 'error', text: `还没有语雀凭据，无法上传。\n${USAGE}` }
  }
  const { title, catalog: inlineCatalog } = parseSaveInput(invocation.rawInput)
  const catalog = inlineCatalog.length > 0 ? inlineCatalog : current.catalog

  // When a directory is chosen at save time, validate it right now: a typo should
  // fail before the agent spends a turn distilling, not after the tool call fails.
  if (inlineCatalog.length > 0) {
    if (auth.kind === 'token') {
      return {
        kind: 'error',
        text: '开放 API 不支持把文档写入指定目录；请改用 /yuque-login 使用网页登录态，或去掉目录写到知识库根目录。',
      }
    }
    try {
      const account = await fetchAccount(auth, current, undefined)
      const books = await fetchBooks(auth, current, account.login, undefined)
      const target = pickBook(books, current.book)
      const nodes = await fetchCatalog(auth, current, target, undefined)
      pickCatalog(nodes, inlineCatalog)
    } catch (error) {
      if (error instanceof YuqueError) {
        return { kind: 'error', text: `保存到目录“${inlineCatalog}”失败：${error.message}\n运行 /yuque-dir 查看可用目录。` }
      }
      throw error
    }
  }

  invocation.agent.followup({
    content: [{ type: 'text', text: distillPrompt({ title, book: current.book, catalog }) }],
    source: { kind: 'yuque-notes' },
  })
  return {
    kind: 'success',
    text: `开始整理本次对话${title.length > 0 ? `（标题：${title}）` : ''}，完成后会上传${current.book.length > 0 ? `到语雀知识库 ${current.book}` : '到语雀默认知识库'}${catalog.length > 0 ? `的「${catalog}」目录` : ''}，随后把文档链接发给你。`,
  }
}

/** Register the commands and the upload tool for the whole profile. */
export function apply(ctx, config) {
  ctx.commands.register({
    name: 'yuque-save',
    description: '把本次对话提炼成笔记并保存到语雀',
    input: { hint: '[标题] [@目录/路径]' },
    handler: (invocation) => handleSave(ctx, config, invocation),
  })
  ctx.commands.register({
    name: 'yuque-login',
    description: '打开浏览器登录语雀并自动抓取登录态（免会员）',
    input: { hint: '[Cookie 或留空自动登录]' },
    handler: (invocation) => handleLogin(ctx, config, invocation),
  })
  ctx.commands.register({
    name: 'yuque-token',
    description: '保存语雀开放 API Token（需会员）',
    input: { hint: '<Token>' },
    handler: (invocation) => handleToken(ctx, invocation),
  })
  ctx.commands.register({
    name: 'yuque-account',
    description: '显示当前语雀登录账号信息',
    handler: () => handleAccount(ctx, config),
  })
  ctx.commands.register({
    name: 'yuque-book',
    description: '查看语雀配置与可用知识库',
    input: { hint: '[筛选词]' },
    handler: (invocation) => handleBook(ctx, config, invocation),
  })
  ctx.commands.register({
    name: 'yuque-dir',
    description: '列出目标知识库的目录，供选择保存位置',
    input: { hint: '[筛选词]' },
    handler: (invocation) => handleDir(ctx, config, invocation),
  })
  ctx.tools.register(defineSaveTool(ctx, config))
}

export { YuqueError }