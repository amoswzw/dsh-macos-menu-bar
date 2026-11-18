/** DSH Host plugin: routes one-shot approvals to the injected macOS main process. */
import { createConnection } from 'node:net'
import { autoInject } from './auto-inject.mjs'
import { readFile } from 'node:fs/promises'
import { readSettings, saveSettings } from './settings.mjs'

export const name = 'macos-menu-bar'
export const inject = ['approval', 'userQuestions', 'webServer']

const outcomes = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

// Desktop settings control the local macOS process. DSH can also serve a profile
// over the network, so keep these routes reachable only from this Mac.
export function isLocalRequest(req) {
  const address = req.socket?.remoteAddress
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1'
}

function requireLocal(req, res) {
  if (isLocalRequest(req)) return true
  res.writeHead(403, { 'cache-control': 'no-store' })
  res.end()
  return false
}

async function within(promise, milliseconds) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('menu bar IPC did not answer')), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

function connect(socketPath, token) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('menu bar IPC timed out')) }, 5000)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

class MenuBarConnection {
  #socket
  #token
  #nextId = 0
  #pending = new Map()
  #input = ''

  constructor(socket, token) {
    this.#socket = socket
    this.#token = token
    socket.setEncoding('utf8')
    socket.on('data', chunk => this.#receive(chunk))
    socket.on('close', () => this.#failAll())
    socket.on('error', () => this.#failAll())
  }

  #receive(chunk) {
    this.#input += chunk
    if (this.#input.length > 16_384) { this.#socket.destroy(); return }
    let newline
    while ((newline = this.#input.indexOf('\n')) !== -1) {
      const line = this.#input.slice(0, newline)
      this.#input = this.#input.slice(newline + 1)
      let reply
      try { reply = JSON.parse(line) } catch { this.#socket.destroy(); return }
      if (!reply || !Number.isSafeInteger(reply.id)) { this.#socket.destroy(); return }
      this.#pending.get(reply.id)?.(reply)
    }
  }

  #failAll() {
    for (const settle of this.#pending.values()) settle({ outcome: 'unavailable' })
    this.#pending.clear()
  }

  request(method, details = {}, signal) {
    if (signal?.aborted) return Promise.resolve({ outcome: 'cancelled' })
    if (this.#socket.destroyed) return Promise.resolve({ outcome: 'unavailable' })
    const id = ++this.#nextId
    return new Promise(resolve => {
      const settle = reply => {
        this.#pending.delete(id)
        signal?.removeEventListener('abort', abort)
        resolve(reply)
      }
      const abort = () => {
        if (!this.#socket.destroyed) this.#socket.write(JSON.stringify({
          token: this.#token, id: ++this.#nextId, method: 'cancel-approval', targetId: id,
        }) + '\n')
        settle({ outcome: 'cancelled' })
      }
      this.#pending.set(id, settle)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      this.#socket.write(JSON.stringify({ token: this.#token, id, method, ...details }) + '\n', error => {
        if (error) settle({ outcome: 'unavailable' })
      })
    })
  }

  close() {
    this.#failAll()
    this.#socket.end()
  }
}

/**
 * Connect Desktop's private menu bar socket and register a native approval answerer.
 * The launcher supplies the socket only to Desktop's Host process.
 */
export async function apply(ctx) {
  if (process.platform !== 'darwin') return
  const recentToolDetails = new Map()
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'tool/call' || typeof event.data?.arguments !== 'string'
      || event.data.arguments.length > 100_000 || typeof event.data.callId !== 'string'
      || typeof session?.id !== 'string') return
    let args
    try { args = JSON.parse(event.data.arguments) } catch { return }
    const direct = event.data.name === 'terminal_send' ? args?.text
      : event.data.name === 'bash' ? args?.command : undefined
    const detail = typeof direct === 'string' ? direct
      : args && typeof args === 'object' && !Array.isArray(args)
        ? Object.entries(args).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n')
        : JSON.stringify(args)
    if (typeof detail !== 'string' || !detail.trim()) return
    let calls = recentToolDetails.get(session.id)
    if (!calls) {
      calls = new Map()
      recentToolDetails.set(session.id, calls)
      if (recentToolDetails.size > 100) recentToolDetails.delete(recentToolDetails.keys().next().value)
    }
    calls.set(event.data.callId, { toolName: event.data.name, detail: detail.slice(0, 4000) })
    if (calls.size > 32) calls.delete(calls.keys().next().value)
  }, { global: true })
  let client
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/macos-menu-bar/settings.html', handler: async (req, res) => {
    if (!requireLocal(req, res)) return
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
    const body = await readFile(new URL('./settings.html', import.meta.url))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  } }), 'macos-menu-bar: settings page')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/macos-menu-bar/settings', handler: async (req, res) => {
    if (!requireLocal(req, res)) return
    try {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(await readSettings()))
      } else if (req.method === 'PUT') {
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 4096) { res.writeHead(413); res.end(); return }
        }
        const next = await saveSettings(JSON.parse(body))
        let applied = false
        if (client) {
          try { applied = (await within(client.request('configure', { settings: next }), 2000)).configured === true }
          catch (error) { console.warn('dsh-macos-menu-bar: settings saved but not applied yet', error) }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
          'x-dsh-settings-applied': String(applied) })
        res.end(JSON.stringify(next))
      } else { res.writeHead(405, { allow: 'GET, PUT' }); res.end() }
    } catch (error) {
      res.writeHead(error instanceof SyntaxError || error instanceof TypeError ? 400 : 500)
      res.end(JSON.stringify({ error: error.message }))
    }
  } }), 'macos-menu-bar: settings API')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/macos-menu-bar/preview-approval', handler: async (req, res) => {
    if (!requireLocal(req, res)) return
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
    if (!client) { res.writeHead(503); res.end(); return }
    try {
      const reply = await within(client.request('preview-approval'), 2000)
      res.writeHead(reply.preview === true ? 202 : 503)
      res.end()
    } catch { res.writeHead(503); res.end() }
  } }), 'macos-menu-bar: approval preview')
  let socketPath = process.env.DSH_MENU_BAR_SOCKET
  let token = process.env.DSH_MENU_BAR_TOKEN
  if (socketPath === undefined || token === undefined) {
    if (!process.argv.some(argument => argument.includes('dsh-desktop-host'))) return
    try { ({ socketPath, token } = await autoInject()) }
    catch (error) {
      console.warn('dsh-macos-menu-bar: automatic Desktop injection unavailable', error)
      return
    }
  }
  if (!socketPath.startsWith('/')) throw new Error('menu bar socket must be an absolute path')
  client = new MenuBarConnection(await connect(socketPath, token), token)
  let ping
  try { ping = await within(client.request('ping'), 3000) }
  catch (error) { client.close(); throw error }
  if (ping.ready !== true) { client.close(); throw new Error('menu bar main process did not become ready') }
  try { await within(client.request('configure', { settings: await readSettings() }), 2000) }
  catch (error) { console.warn('dsh-macos-menu-bar: settings unavailable', error) }
  const syncActivity = () => {
    try {
      const listed = ctx.get?.('agents')?.list()
      const runningCount = Array.isArray(listed) ? listed.filter(agent => agent?.status === 'running').length : 0
      void client.request('activity', { runningCount })
    } catch (error) { console.warn('dsh-macos-menu-bar: agent activity unavailable', error) }
  }
  for (const event of ['agent/created', 'agent/status', 'agent/disposed']) ctx.on(event, syncActivity)
  syncActivity()
  ctx.effect(() => async () => {
    await within(client.request('dispose'), 2000).catch(() => undefined)
    client.close()
  }, 'macos-menu-bar: native connection')
  ctx.on('approval/request', async (request, next) => {
    const linkedCall = recentToolDetails.get(request.agent?.session?.id)?.get(request.callId)
    const command = linkedCall?.toolName === request.toolName ? linkedCall.detail : undefined
    const reply = await client.request('approve', {
      toolName: request.toolName,
      ...(typeof request.agent?.id === 'string' ? { sessionId: request.agent.id } : {}),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(typeof command === 'string' ? { command } : {}),
      ...(request.displayReason === undefined ? {} : { displayReason: {
        ...(typeof request.displayReason.en === 'string' ? { en: request.displayReason.en.slice(0, 4000) } : {}),
        ...(typeof request.displayReason.zh === 'string' ? { zh: request.displayReason.zh.slice(0, 4000) } : {}),
      } }),
    }, request.signal)
    if (reply.outcome === 'review') {
      try { return request.signal?.aborted ? 'cancelled' : await next() }
      finally {
        await within(client.request('finish-review', { targetId: reply.id }), 2000).catch(error => {
          console.warn('dsh-macos-menu-bar: could not advance approval queue after review', error)
        })
      }
    }
    return outcomes.has(reply.outcome) ? reply.outcome : 'unavailable'
  }, { prepend: true })
  ctx.on('user-questions/request', async (request, next) => {
    const question = request.questions.length === 1 ? request.questions[0] : undefined
    const intent = question?.intent
    if (request.wait || intent?.kind !== 'approval') return next()
    if (request.signal?.aborted) throw new DOMException('Approval cancelled', 'AbortError')
    const labels = [intent.reject, intent.approve, ...(intent.always === undefined ? [] : [intent.always])]
    const reply = await client.request('question-approval', {
      question: question.question,
      ...(typeof request.agent?.id === 'string' ? { sessionId: request.agent.id } : {}),
      ...(question.detail === undefined ? {} : { detail: question.detail }),
      labels,
      ...(intent.display === undefined ? {} : { display: intent.display }),
    }, request.signal)
    if (request.signal?.aborted) throw new DOMException('Approval cancelled', 'AbortError')
    if (!labels.includes(reply.selected)) return next()
    return { answers: [{ id: question.id, selected: [reply.selected] }] }
  }, { prepend: true })
}
