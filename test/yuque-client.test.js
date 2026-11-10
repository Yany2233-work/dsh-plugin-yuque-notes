import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_API_BASE,
  YuqueError,
  createDoc,
  createSessionDoc,
  documentUrl,
  getCurrentUser,
  getSessionAccount,
  listBooks,
  listSessionBooks,
  listSessionToc,
  listToc,
  parseSessionCookie,
  resolveBook,
  resolveCatalogNode,
} from '../lib/yuque-client.js'

/** Build a fake fetch that records calls and answers from a route table. */
function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init) => {
    const parsed = new URL(url)
    calls.push({ url: parsed.toString(), path: parsed.pathname, query: parsed.searchParams, init })
    const handler = routes[`${init.method ?? 'GET'} ${parsed.pathname}`]
    if (handler === undefined) throw new Error(`unexpected request: ${init.method} ${parsed.pathname}`)
    const { status = 200, body } = handler
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return new Response(text, { status, headers: { 'content-type': 'application/json' } })
  }
  impl.calls = calls
  return impl
}

test('documentUrl joins namespace and slug', () => {
  assert.equal(documentUrl('alice/kb', 'abc123'), 'https://www.yuque.com/alice/kb/abc123')
})

test('getCurrentUser authenticates with the token header and returns the login', async () => {
  const fetchImpl = fakeFetch({
    'GET /api/v2/user': { body: { data: { id: 1, login: 'alice', name: 'Alice' } } },
  })
  const user = await getCurrentUser({ token: 'tok', fetchImpl })
  assert.equal(user.login, 'alice')
  assert.equal(fetchImpl.calls[0].init.headers['X-Auth-Token'], 'tok')
  assert.ok(fetchImpl.calls[0].url.startsWith(DEFAULT_API_BASE))
})

test('listBooks filters to namespace-bearing books and asks for type=Book', async () => {
  const fetchImpl = fakeFetch({
    'GET /api/v2/users/alice/repos': {
      body: {
        data: [
          { id: 7, name: '笔记', namespace: 'alice/notes', slug: 'notes' },
          { id: 8, name: 'broken' },
        ],
      },
    },
  })
  const books = await listBooks({ token: 'tok', fetchImpl }, 'alice')
  assert.deepEqual(books.map((book) => book.namespace), ['alice/notes'])
  assert.equal(fetchImpl.calls[0].query.get('type'), 'Book')
})

test('resolveBook prefers the configured namespace without any request', async () => {
  const fetchImpl = fakeFetch({})
  const resolved = await resolveBook({ token: 'tok', fetchImpl }, 'alice/kb')
  assert.equal(resolved.namespace, 'alice/kb')
  assert.equal(fetchImpl.calls.length, 0)
})

test('resolveBook falls back to the first book of the token owner', async () => {
  const fetchImpl = fakeFetch({
    'GET /api/v2/user': { body: { data: { login: 'alice' } } },
    'GET /api/v2/users/alice/repos': {
      body: { data: [{ id: 1, name: 'A', namespace: 'alice/a' }, { id: 2, name: 'B', namespace: 'alice/b' }] },
    },
  })
  const resolved = await resolveBook({ token: 'tok', fetchImpl })
  assert.equal(resolved.namespace, 'alice/a')
  assert.equal(resolved.books.length, 2)
})

test('resolveBook rejects a malformed namespace and an empty account', async () => {
  await assert.rejects(
    () => resolveBook({ token: 'tok', fetchImpl: fakeFetch({}) }, 'nonsense'),
    (error) => error instanceof YuqueError && error.code === 'BAD_NAMESPACE',
  )
  const empty = fakeFetch({
    'GET /api/v2/user': { body: { data: { login: 'alice' } } },
    'GET /api/v2/users/alice/repos': { body: { data: [] } },
  })
  await assert.rejects(
    () => resolveBook({ token: 'tok', fetchImpl: empty }),
    (error) => error instanceof YuqueError && error.code === 'NO_BOOK',
  )
})

test('createDoc posts Markdown to the encoded namespace and returns the document URL', async () => {
  const fetchImpl = fakeFetch({
    'POST /api/v2/repos/alice/notes/docs': {
      body: { data: { id: 42, slug: 'abc123', title: 'T' } },
    },
  })
  const doc = await createDoc({
    token: 'tok',
    fetchImpl,
    namespace: 'alice/notes',
    title: '  提炼结果  ',
    markdown: '# 标题\n\n正文',
  })
  assert.equal(doc.url, 'https://www.yuque.com/alice/notes/abc123')
  assert.equal(doc.title, 'T')
  const sent = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(sent.title, '提炼结果')
  assert.equal(sent.body_format, 'markdown')
  assert.equal(sent.body, '# 标题\n\n正文')
  assert.equal(sent.public, 0)
  assert.equal(fetchImpl.calls[0].init.method, 'POST')
})

test('request surfaces HTTP failures with a diagnosis code', async () => {
  const fetchImpl = fakeFetch({
    'GET /api/v2/user': { status: 401, body: { message: 'invalid token' } },
  })
  await assert.rejects(
    () => getCurrentUser({ token: 'tok', fetchImpl }),
    (error) => error instanceof YuqueError && error.status === 401 && error.code === 'AUTH' && /invalid token/.test(error.message),
  )
})

test('request refuses to run without a token or fetch', async () => {
  await assert.rejects(
    () => getCurrentUser({ token: '   ', fetchImpl: fakeFetch({}) }),
    (error) => error instanceof YuqueError && error.code === 'TOKEN_MISSING',
  )
  await assert.rejects(
    () => getCurrentUser({ token: 'tok', fetchImpl: undefined, apiBase: 'http://127.0.0.1:1' }).then(() => {
      throw new Error('expected a network failure')
    }),
    (error) => error instanceof YuqueError,
  )
})

test('parseSessionCookie normalizes the pasted line and extracts ctoken', () => {
  const parsed = parseSessionCookie('Cookie: _yuque_session=abc;   ctoken=tok-1;  lang=zh-CN')
  assert.equal(parsed.csrf, 'tok-1')
  assert.equal(parsed.cookie, '_yuque_session=abc; ctoken=tok-1; lang=zh-CN')
  assert.equal(parseSessionCookie('_yuque_session=abc').csrf, undefined)
  assert.throws(() => parseSessionCookie('   '), (error) => error.code === 'EMPTY_COOKIE')
})

test('getSessionAccount reads /api/mine with the cookie and no token header', async () => {
  const fetchImpl = fakeFetch({
    'GET /api/mine': { body: { data: { id: 5, login: 'alice', name: 'Alice' } } },
  })
  const user = await getSessionAccount({ cookie: '_yuque_session=abc; ctoken=tok-1', fetchImpl })
  assert.equal(user.login, 'alice')
  const call = fetchImpl.calls[0]
  assert.ok(call.url.startsWith('https://www.yuque.com/api/mine'))
  assert.match(call.init.headers.Cookie, /_yuque_session=abc/)
  assert.equal(call.init.headers['X-Auth-Token'], undefined)
})

test('listSessionBooks keeps only book-shaped rows', async () => {
  const fetchImpl = fakeFetch({
    'GET /api/mine/books': { body: { data: [{ id: 7, name: '笔记', slug: 'notes' }, 'junk', { name: 'no id' }] } },
  })
  const books = await listSessionBooks({ cookie: '_yuque_session=abc', fetchImpl })
  assert.deepEqual(books.map((book) => book.id), [7])
})

test('createSessionDoc sends csrf, cookie, origin and a markdown body', async () => {
  const fetchImpl = fakeFetch({
    'POST /api/docs': { body: { data: { id: 9, slug: 'd1', title: 'T' } } },
  })
  const doc = await createSessionDoc({
    cookie: '_yuque_session=abc; ctoken=tok-1',
    csrf: 'tok-1',
    bookId: 77,
    namespace: 'alice/notes',
    title: '  标题  ',
    markdown: '# 标题\n\n正文',
    fetchImpl,
  })
  assert.equal(doc.url, 'https://www.yuque.com/alice/notes/d1')
  assert.equal(doc.namespace, 'alice/notes')
  const call = fetchImpl.calls[0]
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers['x-csrf-token'], 'tok-1')
  assert.equal(call.init.headers.Origin, 'https://www.yuque.com')
  assert.equal(call.init.headers.Referer, 'https://www.yuque.com/')
  const sent = JSON.parse(call.init.body)
  assert.equal(sent.book_id, 77)
  assert.equal(sent.title, '标题')
  assert.equal(sent.body_format, 'markdown')
  assert.equal(sent.public, 0)
})

test('createSessionDoc places the document under a 目录 folder via parent_id', async () => {
  const fetchImpl = fakeFetch({
    'POST /api/docs': { body: { data: { id: 9, slug: 'd2', title: 'T' } } },
  })
  await createSessionDoc({
    cookie: '_yuque_session=abc; ctoken=tok-1',
    csrf: 'tok-1',
    bookId: 77,
    namespace: 'alice/notes',
    title: 'T',
    markdown: 'body',
    parentId: 100,
    fetchImpl,
  })
  const sent = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(sent.parent_id, 100)
  assert.equal(sent.parent_uuid, undefined)
})

test('createSessionDoc falls back to parent_uuid when only a uuid is known', async () => {
  const fetchImpl = fakeFetch({
    'POST /api/docs': { body: { data: { id: 9, slug: 'd3', title: 'T' } } },
  })
  await createSessionDoc({
    cookie: '_yuque_session=abc; ctoken=tok-1',
    csrf: 'tok-1',
    bookId: 77,
    namespace: 'alice/notes',
    title: 'T',
    markdown: 'body',
    parentUuid: 'uuid-1',
    fetchImpl,
  })
  const sent = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(sent.parent_id, undefined)
  assert.equal(sent.parent_uuid, 'uuid-1')
})

test('listSessionToc reads /api/books/{bookId}/toc and normalizes nodes', async () => {
  const fetchImpl = fakeFetch({
    'GET /api/books/77/toc': {
      body: {
        data: [
          { id: 100, title: '复盘', parent_id: 0, depth: 0 },
          { id: 101, title: '周报', parent_id: 100, depth: 1 },
        ],
      },
    },
  })
  const nodes = await listSessionToc({ cookie: '_yuque_session=abc', bookId: 77, fetchImpl })
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].title, '复盘')
  assert.equal(nodes[1].parentId, 100)
  assert.equal(nodes[1].depth, 1)
  assert.ok(fetchImpl.calls[0].url.startsWith('https://www.yuque.com/api/books/77/toc'))
})

test('listToc reads the v2 /repos/{namespace}/toc endpoint with the token', async () => {
  const fetchImpl = fakeFetch({
    'GET /api/v2/repos/alice/notes/toc': {
      body: { data: [{ uuid: 'u1', title: '归档', parent_uuid: '', depth: 0 }] },
    },
  })
  const nodes = await listToc({ token: 'tok', namespace: 'alice/notes', fetchImpl })
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].uuid, 'u1')
  assert.equal(nodes[0].title, '归档')
  assert.equal(fetchImpl.calls[0].init.headers['X-Auth-Token'], 'tok')
})

test('resolveCatalogNode matches exact title, then a slash path', () => {
  const nodes = [
    { id: 1, title: '工作', parentId: 0, depth: 0 },
    { id: 2, title: '复盘', parentId: 1, depth: 1 },
    { id: 3, title: '生活', parentId: 0, depth: 0 },
  ]
  assert.equal(resolveCatalogNode(nodes, '生活').id, 3)
  assert.equal(resolveCatalogNode(nodes, ' 复盘 ').id, 2)
  assert.equal(resolveCatalogNode(nodes, '工作/复盘').id, 2)
  assert.equal(resolveCatalogNode(nodes, '不存在'), undefined)
  assert.equal(resolveCatalogNode(nodes, ''), undefined)
})