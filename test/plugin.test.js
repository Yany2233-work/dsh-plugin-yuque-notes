import assert from 'node:assert/strict'
import { test } from 'node:test'

/** Build a minimal Cordis-like context exposing only what the plugin injects. */
function fakeContext() {
  const registered = { commands: new Map(), tools: new Map() }
  const secrets = new Map()
  const ctx = {
    commands: {
      register(definition) {
        assert.ok(!registered.commands.has(definition.name), `duplicate command ${definition.name}`)
        registered.commands.set(definition.name, definition)
        return () => registered.commands.delete(definition.name)
      },
    },
    tools: {
      register(definition) {
        assert.ok(!registered.tools.has(definition.name), `duplicate tool ${definition.name}`)
        registered.tools.set(definition.name, definition)
        return () => registered.tools.delete(definition.name)
      },
    },
    credentials: {
      async resolve(ref) {
        return secrets.has(ref) ? { value: secrets.get(ref), source: 'stored' } : undefined
      },
      async set(ref, value) {
        secrets.set(ref, value)
      },
    },
  }
  return { ctx, registered, secrets }
}

/** Build a fake agent that records follow-up input. */
function fakeAgent() {
  const followups = []
  return {
    followups,
    agent: {
      followup(message) {
        followups.push(message)
      },
    },
  }
}

/** Route-table fetch stub: `{ 'GET /api/mine': { status, body } }`. */
function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init = {}) => {
    const parsed = new URL(url)
    const key = `${init.method ?? 'GET'} ${parsed.pathname}`
    calls.push({ key, url: parsed.toString(), init })
    const handler = routes[key]
    if (handler === undefined) throw new Error(`unexpected request: ${key}`)
    const text = typeof handler.body === 'string' ? handler.body : JSON.stringify(handler.body ?? {})
    return new Response(text, { status: handler.status ?? 200 })
  }
  impl.calls = calls
  return impl
}

/** Run one test body with a stubbed global fetch. */
async function withFetch(impl, body) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await body()
  } finally {
    globalThis.fetch = original
  }
}

const SESSION = '_yuque_session=abc; ctoken=tok-1'

const { apply, parseSaveInput } = await import('../index.js')

test('parseSaveInput splits title and directory', () => {
  assert.deepEqual(parseSaveInput('部署复盘'), { title: '部署复盘', catalog: '' })
  assert.deepEqual(parseSaveInput('@工作/复盘'), { title: '', catalog: '工作/复盘' })
  assert.deepEqual(parseSaveInput('部署复盘 @工作/复盘'), { title: '部署复盘', catalog: '工作/复盘' })
  assert.deepEqual(parseSaveInput('部署复盘 --catalog 复盘'), { title: '部署复盘', catalog: '复盘' })
  assert.deepEqual(parseSaveInput('部署复盘 --dir 复盘'), { title: '部署复盘', catalog: '复盘' })
  assert.deepEqual(parseSaveInput('部署复盘 --目录 "工作/复盘"'), { title: '部署复盘', catalog: '工作/复盘' })
  assert.deepEqual(parseSaveInput("部署复盘 --目录 '工作/复盘'"), { title: '部署复盘', catalog: '工作/复盘' })
  assert.deepEqual(parseSaveInput(' @复盘 '), { title: '', catalog: '复盘' })
  // Flag wins when both a flag and a @token are present, but both leave the title.
  assert.deepEqual(parseSaveInput('标题 --catalog A @B'), { title: '标题', catalog: 'A' })
})

test('apply registers six commands and the upload tool', () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, {})
  assert.deepEqual(
    [...registered.commands.keys()].sort(),
    ['yuque-account', 'yuque-book', 'yuque-dir', 'yuque-login', 'yuque-save', 'yuque-token'],
  )
  assert.deepEqual([...registered.tools.keys()], ['yuque_save'])
})

test('tool schemas stay inside the JSON Schema subset DSH accepts', () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, {})
  const tool = registered.tools.get('yuque_save')
  for (const [label, schema] of [['parameters', tool.parameters], ['output.schema', tool.output.schema]]) {
    assert.ok(Array.isArray(schema.required), `${label}.required must be an array of property names`)
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      assert.equal(property.required, undefined, `${label}.properties.${key} must not carry "required"`)
    }
  }
  assert.deepEqual(tool.output.schema.required, ['url', 'title', 'namespace', 'slug'])
})

test('/yuque-login validates the cookie and stores the session', async () => {
  const { ctx, registered, secrets } = fakeContext()
  apply(ctx, {})
  const result = await withFetch(
    fakeFetch({ 'GET /api/mine': { body: { data: { id: 5, login: 'alice', name: 'Alice' } } } }),
    () => registered.commands.get('yuque-login').handler({ rawInput: SESSION, agent: {} }),
  )
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Alice/)
  assert.equal(secrets.get('YUQUE_SESSION'), SESSION)
})

test('/yuque-login reports a friendly error when verification fails', async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, {})
  const result = await withFetch(
    fakeFetch({ 'GET /api/mine': { status: 401, body: { message: 'Unauthorized' } } }),
    () => registered.commands.get('yuque-login').handler({ rawInput: '_yuque_session=expired', agent: {} }),
  )
  assert.equal(result.kind, 'error')
  assert.match(result.text, /验证失败/)
  assert.match(result.text, /yuque-login/)
})

test('/yuque-token stores the token in the credential store', async () => {
  const { ctx, registered, secrets } = fakeContext()
  apply(ctx, {})
  await withFetch(
    fakeFetch({ 'GET /api/v2/user': { body: { data: { login: 'alice', name: 'Alice' } } } }),
    () => registered.commands.get('yuque-token').handler({ rawInput: '  tok-123  ', agent: {} }),
  )
  assert.equal(secrets.get('YUQUE_TOKEN'), 'tok-123')
})

test('/yuque-save asks the agent to distill and upload', async () => {
  const { ctx, registered, secrets } = fakeContext()
  secrets.set('YUQUE_SESSION', SESSION)
  apply(ctx, { book: 'alice/notes' })
  const { agent, followups } = fakeAgent()
  const result = await registered.commands.get('yuque-save').handler({ rawInput: '部署复盘', agent })
  assert.equal(result.kind, 'success')
  assert.equal(followups.length, 1)
  const text = followups[0].content[0].text
  assert.match(text, /yuque_save/)
  assert.match(text, /部署复盘/)
  assert.match(text, /alice\/notes/)
})

test('/yuque-save refuses to start without any credential', async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, {})
  const { agent, followups } = fakeAgent()
  const result = await registered.commands.get('yuque-save').handler({ rawInput: '', agent })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /yuque-login/)
  assert.equal(followups.length, 0)
})

test('/yuque-save validates a save-time directory and threads it into the prompt', async () => {
  const { ctx, registered, secrets } = fakeContext()
  secrets.set('YUQUE_SESSION', SESSION)
  apply(ctx, {})
  const fetchImpl = fakeFetch({
    'GET /api/mine': { body: { data: { id: 5, login: 'alice', name: 'Alice' } } },
    'GET /api/mine/books': { body: { data: [{ id: 77, name: '笔记', slug: 'notes' }] } },
    'GET /api/books/77/toc': { body: { data: [{ id: 100, title: '复盘', parent_id: 0, depth: 0 }] } },
  })
  const { agent, followups } = fakeAgent()
  const result = await withFetch(
    fetchImpl,
    () => registered.commands.get('yuque-save').handler({ rawInput: '部署复盘 @复盘', agent }),
  )
  assert.equal(result.kind, 'success')
  assert.match(result.text, /「复盘」目录/)
  const prompt = followups[0].content[0].text
  assert.match(prompt, /catalog 参数传 "复盘"/)
  assert.match(prompt, /部署复盘/)
})

test('/yuque-save errors immediately when the directory does not exist', async () => {
  const { ctx, registered, secrets } = fakeContext()
  secrets.set('YUQUE_SESSION', SESSION)
  apply(ctx, {})
  const fetchImpl = fakeFetch({
    'GET /api/mine': { body: { data: { id: 5, login: 'alice' } } },
    'GET /api/mine/books': { body: { data: [{ id: 77, name: '笔记', slug: 'notes' }] } },
    'GET /api/books/77/toc': { body: { data: [{ id: 100, title: '复盘', parent_id: 0, depth: 0 }] } },
  })
  const { agent, followups } = fakeAgent()
  const result = await withFetch(
    fetchImpl,
    () => registered.commands.get('yuque-save').handler({ rawInput: '标题 @不存在', agent }),
  )
  assert.equal(result.kind, 'error')
  assert.match(result.text, /不存在/)
  assert.match(result.text, /yuque-dir/)
  assert.equal(followups.length, 0)
})

test('/yuque-save rejects a save-time directory in token mode before distilling', async () => {
  const { ctx, registered, secrets } = fakeContext()
  secrets.set('YUQUE_TOKEN', 'tok')
  apply(ctx, { book: 'alice/notes' })
  const { agent, followups } = fakeAgent()
  const result = await registered.commands.get('yuque-save').handler({ rawInput: '标题 @复盘', agent })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /yuque-login/)
  assert.equal(followups.length, 0)
})

test('yuque_save uploads through the Open API when a token is configured', async () => {
  const { ctx, registered, secrets } = fakeContext()
  secrets.set('YUQUE_TOKEN', 'tok')
  apply(ctx, { book: 'alice/notes' })
  const tool = registered.tools.get('yuque_save')
  const fetchImpl = fakeFetch({
    'GET /api/v2/user': { body: { data: { login: 'alice' } } },
    'GET /api/v2/users/alice/repos': { body: { data: [{ namespace: 'alice/notes', name: 'Notes' }] } },
    'POST /api/v2/repos/alice/notes/docs': { body: { data: { id: 1, slug: 's1', title: 'T' } } },
  })
  const result = await withFetch(
    fetchImpl,
    () => tool.execute({ title: 'T', markdown: '# T\n\nbody' }, { signal: new AbortController().signal }),
  )
  assert.equal(result.url, 'https://www.yuque.com/alice/notes/s1')
  assert.equal(result.namespace, 'alice/notes')
  const sent = JSON.parse(fetchImpl.calls.at(-1).init.body)
  assert.equal(sent.body_format, 'markdown')
  assert.equal(sent.body, '# T\n\nbody')
})

test('yuque_save uploads through the web session when only a cookie is configured', async () => {
  const { ctx, registered, secrets } = fakeContext()
  secrets.set('YUQUE_SESSION', SESSION)
  apply(ctx, {})
  const tool = registered.tools.get('yuque_save')
  const fetchImpl = fakeFetch({
    'GET /api/mine': { body: { data: { id: 5, login: 'alice', name: 'Alice' } } },
    'GET /api/mine/books': { body: { data: [{ id: 77, name: '笔记', slug: 'notes' }] } },
    'POST /api/docs': { body: { data: { id: 9, slug: 'd1', title: 'T' } } },
  })
  const result = await withFetch(
    fetchImpl,
    () => tool.execute({ title: 'T', markdown: 'body' }, { signal: new AbortController().signal }),
  )
  assert.equal(result.url, 'https://www.yuque.com/alice/notes/d1')
  assert.equal(result.namespace, 'alice/notes')
  const post = fetchImpl.calls.at(-1)
  assert.equal(post.init.headers['x-csrf-token'], 'tok-1')
  assert.match(post.init.headers.Cookie, /_yuque_session=abc/)
  assert.equal(post.init.headers.Origin, 'https://www.yuque.com')
  const sent = JSON.parse(post.init.body)
  assert.equal(sent.book_id, 77)
  assert.equal(sent.body_format, 'markdown')
})

test('yuque_save reports a missing credential', async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, {})
  const tool = registered.tools.get('yuque_save')
  await assert.rejects(
    () => tool.execute({ title: 'T', markdown: 'body' }, { signal: new AbortController().signal }),
    /yuque-login/,
  )
})

test('/yuque-account renders the session account and credential type', async () => {
  const { ctx, registered, secrets } = fakeContext()
  secrets.set('YUQUE_SESSION', SESSION)
  apply(ctx, {})
  const result = await withFetch(
    fakeFetch({
      'GET /api/mine': { body: { data: { id: 5, login: 'alice', name: 'Alice' } } },
      'GET /api/mine/books': { body: { data: [{ id: 1, name: 'A', slug: 'a' }, { id: 2, name: 'B', slug: 'b' }] } },
    }),
    () => registered.commands.get('yuque-account').handler({ rawInput: '', agent: {} }),
  )
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Alice/)
  assert.match(result.text, /网页登录态/)
  assert.match(result.text, /可用知识库：2 个/)
})

test('/yuque-account reports an expired session', async () => {
  const { ctx, registered, secrets } = fakeContext()
  secrets.set('YUQUE_SESSION', SESSION)
  apply(ctx, {})
  const result = await withFetch(
    fakeFetch({ 'GET /api/mine': { status: 401, body: { message: 'Unauthorized' } } }),
    () => registered.commands.get('yuque-account').handler({ rawInput: '', agent: {} }),
  )
  assert.equal(result.kind, 'error')
  assert.match(result.text, /401/)
  assert.match(result.text, /yuque-login/)
})

test('/yuque-book lists knowledge bases for a web session', async () => {
  const { ctx, registered, secrets } = fakeContext()
  secrets.set('YUQUE_SESSION', SESSION)
  apply(ctx, {})
  const result = await withFetch(
    fakeFetch({
      'GET /api/mine': { body: { data: { login: 'alice', name: 'Alice' } } },
      'GET /api/mine/books': { body: { data: [{ id: 1, name: '笔记', slug: 'notes' }] } },
    }),
    () => registered.commands.get('yuque-book').handler({ rawInput: 'list', agent: {} }),
  )
  assert.equal(result.kind, 'success')
  assert.match(result.text, /alice\/notes/)
  assert.match(result.text, /网页登录态/)
})

test('yuque_save places the document under a 目录 folder when catalog is given', async () => {
  const { ctx, registered, secrets } = fakeContext()
  secrets.set('YUQUE_SESSION', SESSION)
  apply(ctx, {})
  const tool = registered.tools.get('yuque_save')
  const fetchImpl = fakeFetch({
    'GET /api/mine': { body: { data: { id: 5, login: 'alice', name: 'Alice' } } },
    'GET /api/mine/books': { body: { data: [{ id: 77, name: '笔记', slug: 'notes' }] } },
    'GET /api/books/77/toc': { body: { data: [{ id: 100, title: '复盘', parent_id: 0, depth: 0 }] } },
    'POST /api/docs': { body: { data: { id: 9, slug: 'd1', title: 'T' } } },
  })
  const result = await withFetch(
    fetchImpl,
    () => tool.execute({ title: 'T', markdown: 'body', catalog: '复盘' }, { signal: new AbortController().signal }),
  )
  assert.equal(result.url, 'https://www.yuque.com/alice/notes/d1')
  const post = fetchImpl.calls.at(-1)
  const sent = JSON.parse(post.init.body)
  assert.equal(sent.parent_id, 100)
})

test('yuque_save rejects a catalog in token mode with a clear message', async () => {
  const { ctx, registered, secrets } = fakeContext()
  secrets.set('YUQUE_TOKEN', 'tok')
  apply(ctx, { book: 'alice/notes' })
  const tool = registered.tools.get('yuque_save')
  const fetchImpl = fakeFetch({
    'GET /api/v2/user': { body: { data: { login: 'alice' } } },
    'GET /api/v2/users/alice/repos': { body: { data: [{ namespace: 'alice/notes', name: 'Notes', id: 1 }] } },
  })
  await withFetch(
    fetchImpl,
    () => assert.rejects(
      () => tool.execute({ title: 'T', markdown: 'body', catalog: '复盘' }, { signal: new AbortController().signal }),
      (error) => error instanceof Error && /yuque-login/.test(error.message),
    ),
  )
})

test('/yuque-dir lists the 目录 tree of the target book', async () => {
  const { ctx, registered, secrets } = fakeContext()
  secrets.set('YUQUE_SESSION', SESSION)
  apply(ctx, { book: 'alice/notes' })
  const fetchImpl = fakeFetch({
    'GET /api/mine': { body: { data: { id: 5, login: 'alice', name: 'Alice' } } },
    'GET /api/mine/books': { body: { data: [{ id: 77, name: '笔记', slug: 'notes' }] } },
    'GET /api/books/77/toc': {
      body: { data: [{ id: 100, title: '复盘', parent_id: 0, depth: 0 }, { id: 101, title: '周报', parent_id: 100, depth: 1 }] },
    },
  })
  const result = await withFetch(
    fetchImpl,
    () => registered.commands.get('yuque-dir').handler({ rawInput: '', agent: {} }),
  )
  assert.equal(result.kind, 'success')
  assert.match(result.text, /复盘/)
  assert.match(result.text, /周报/)
})