#!/usr/bin/env node
/** Launch signed DSH Desktop and install the menu bar bridge through a temporary loopback inspector. */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeAddonPath } from '../native/build.mjs'

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

function menuBarReady(socketPath, token) {
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

class Inspector {
  #socket
  #nextId = 0
  #pending = new Map()

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', event => {
      const frame = JSON.parse(event.data)
      if (!Number.isSafeInteger(frame.id)) return
      const settle = this.#pending.get(frame.id)
      if (settle) { this.#pending.delete(frame.id); settle(frame) }
    })
    socket.addEventListener('close', () => {
      for (const settle of this.#pending.values()) settle({ error: { message: 'Inspector closed' } })
      this.#pending.clear()
    })
  }

  async evaluate(expression) {
    const id = ++this.#nextId
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error('Desktop inspector did not answer'))
      }, 5000)
      this.#pending.set(id, frame => { clearTimeout(timeout); resolve(frame) })
      this.#socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
        expression, returnByValue: true, awaitPromise: false,
      } }))
    })
    if (result.error || result.result?.exceptionDetails) {
      throw new Error(result.error?.message ?? result.result?.exceptionDetails?.text ?? 'Desktop injection failed')
    }
    return result.result?.result?.value
  }

  close() { this.#socket.close() }
}

async function inspectorFor(port, stopped) {
  let url
  for (let attempt = 0; attempt < 100; attempt++) {
    if (stopped()) throw new Error('Desktop exited before the menu bar could be installed; quit an existing instance first')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) url = (await response.json())[0]?.webSocketDebuggerUrl
      if (url) break
    } catch { /* Desktop is still starting. */ }
    await delay(100)
  }
  if (!url) throw new Error('Desktop inspector did not start')
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  return new Inspector(socket)
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('dsh-macos-menu-bar requires macOS')
  const appPath = process.argv[2] ?? process.env.DSH_DESKTOP_APP ?? '/Applications/DeepSeek Harness.app'
  const binary = appPath.endsWith('.app') ? join(appPath, 'Contents', 'MacOS', 'DeepSeek Harness') : appPath
  await stat(binary)
  const port = await freePort()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-menu-bar-'))
  const socketPath = join(directory, 'main.sock')
  const token = randomBytes(32).toString('hex')
  const environment = { ...process.env, DSH_MENU_BAR_SOCKET: socketPath, DSH_MENU_BAR_TOKEN: token }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(binary, [`--inspect=127.0.0.1:${port}`, ...process.argv.slice(3)], {
    detached: true,
    stdio: 'ignore',
    env: environment,
  })
  let stopped = false
  child.once('error', () => { stopped = true })
  child.once('exit', () => { stopped = true })
  let inspector
  try {
    inspector = await inspectorFor(port, () => stopped)
    let identity
    for (let attempt = 0; attempt < 50; attempt++) {
      try { identity = await inspector.evaluate('({ pid: process.pid, executable: process.execPath })') }
      catch { /* Node is still initializing. */ }
      if (identity?.pid === child.pid && typeof identity.executable === 'string') break
      await delay(100)
    }
    if (identity?.pid !== child.pid || typeof identity.executable !== 'string') {
      throw new Error('Inspector did not belong to the initialized Desktop process')
    }
    const source = await readFile(new URL('../injected-main.cjs', import.meta.url), 'utf8')
    const addonPath = await nativeAddonPath().catch(error => {
      console.warn('dsh-macos-menu-bar: native notch panel unavailable', error)
      return undefined
    })
    const result = await inspector.evaluate(source.replace('__DSH_MENU_BAR_CONFIG__', JSON.stringify({ socketPath, token, addonPath })))
    if (result !== 'installed') throw new Error(`Desktop menu bar injection failed: ${String(result)}`)
    let ready = false
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await stat(socketPath); ready = await menuBarReady(socketPath, token) } catch { /* IPC not listening yet. */ }
      if (ready) break
      await delay(100)
    }
    if (!ready) throw new Error('Desktop menu bar IPC did not start')
    await delay(300)
    if (stopped) throw new Error('Desktop exited after injection; quit an existing instance first')
    console.log('DeepSeek Harness menu bar started.')
    child.unref()
  } catch (error) {
    child.kill('SIGTERM')
    throw error
  } finally { inspector?.close() }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
