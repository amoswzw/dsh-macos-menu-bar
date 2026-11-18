/** Install the main-process bridge when Desktop was opened through Finder or the Dock. */
import { randomBytes } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeAddonPath } from './native/build.mjs'

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

class Inspector {
  #socket
  #nextId = 0
  #pending = new Map()

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', event => {
      let frame
      try { frame = JSON.parse(event.data) } catch { return }
      if (!Number.isSafeInteger(frame.id)) return
      const settle = this.#pending.get(frame.id)
      if (settle) { this.#pending.delete(frame.id); settle(frame) }
    })
    socket.addEventListener('close', () => {
      for (const settle of this.#pending.values()) settle({ error: { message: 'Inspector closed' } })
      this.#pending.clear()
    })
  }

  async evaluate(expression, timeoutMs = 5000) {
    const id = ++this.#nextId
    const frame = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.#pending.delete(id); reject(new Error('Desktop inspector did not answer')) }, timeoutMs)
      this.#pending.set(id, value => { clearTimeout(timeout); resolve(value) })
      this.#socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
        expression, returnByValue: true, awaitPromise: false,
      } }))
    })
    if (frame.error || frame.result?.exceptionDetails) {
      throw new Error(frame.error?.message ?? frame.result?.exceptionDetails?.text ?? 'Desktop injection failed')
    }
    return frame.result?.result?.value
  }

  close() { this.#socket.close() }
}

async function inspectorOn(port, pid) {
  let url
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(300) })
    if (response.ok) url = (await response.json())[0]?.webSocketDebuggerUrl
  } catch { return undefined }
  if (typeof url !== 'string') return undefined
  const socket = new WebSocket(url)
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true })
        socket.addEventListener('error', reject, { once: true })
      }),
      delay(1000).then(() => { throw new Error('Inspector connection timed out') }),
    ])
    const inspector = new Inspector(socket)
    const identity = await inspector.evaluate('({ pid: process.pid, executable: process.execPath })', 700)
    if (identity?.pid === pid && typeof identity.executable === 'string') return inspector
    inspector.close()
  } catch { socket.close() }
  return undefined
}

async function ownInspector(pid) {
  process.kill(pid, 'SIGUSR1')
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidates = await Promise.all(Array.from({ length: 6 }, (_, index) => inspectorOn(9229 + index, pid)))
    const inspector = candidates.find(Boolean)
    if (inspector) {
      for (const other of candidates) if (other && other !== inspector) other.close()
      return inspector
    }
    await delay(100)
  }
  throw new Error('Desktop did not expose its main-process inspector after SIGUSR1')
}

function ready(socketPath, token) {
  return new Promise(resolve => {
    const socket = createConnection(socketPath)
    const timeout = setTimeout(() => { socket.destroy(); resolve(false) }, 500)
    socket.once('connect', () => socket.write(JSON.stringify({ token, id: 1, method: 'ping' }) + '\n'))
    socket.once('data', chunk => {
      clearTimeout(timeout)
      socket.end()
      try { resolve(JSON.parse(chunk.toString()).ready === true) }
      catch { resolve(false) }
    })
    socket.once('error', () => { clearTimeout(timeout); resolve(false) })
  })
}

export async function autoInject() {
  const pid = process.ppid
  const directory = await mkdtemp(join(tmpdir(), 'dsh-menu-bar-'))
  const socketPath = join(directory, 'main.sock')
  const token = randomBytes(32).toString('hex')
  let inspector
  try {
    inspector = await ownInspector(pid)
    const source = await readFile(new URL('./injected-main.cjs', import.meta.url), 'utf8')
    const addonPath = await nativeAddonPath().catch(error => {
      console.warn('dsh-macos-menu-bar: native notch panel unavailable', error)
      return undefined
    })
    const result = await inspector.evaluate(source.replace('__DSH_MENU_BAR_CONFIG__', JSON.stringify({ socketPath, token, addonPath })))
    if (result !== 'installed') throw new Error(`Desktop menu bar injection failed: ${String(result)}`)
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await ready(socketPath, token)) return { socketPath, token }
      await delay(100)
    }
    throw new Error('Desktop menu bar did not become ready')
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  } finally { inspector?.close() }
}
