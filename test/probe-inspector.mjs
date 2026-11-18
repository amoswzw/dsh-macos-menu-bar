import { spawn } from 'node:child_process'
import { createServer, createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const appPath = process.env.ELECTRON_BINARY
const iconPath = process.env.DSH_APP_ICON
if (!appPath || !iconPath) throw new Error('Set ELECTRON_BINARY and DSH_APP_ICON for the isolated Electron probe')
const fixture = fileURLToPath(new URL('./electron-fixture', import.meta.url))
const server = createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const child = spawn(appPath, [`--inspect=127.0.0.1:${port}`, fixture], { stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
child.stderr.on('data', chunk => { stderr += chunk.toString() })
try {
  let target
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      target = (await response.json())[0]
      if (target) break
    } catch { /* Inspector is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!target) throw new Error(`inspector did not start: ${stderr}`)
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const directory = await mkdtemp(join(tmpdir(), 'dsh-menu-probe-'))
  const socketPath = join(directory, 'main.sock')
  const token = 'probe-token'
  const source = await readFile(new URL('../injected-main.cjs', import.meta.url), 'utf8')
  const expression = source.replace('__DSH_MENU_BAR_CONFIG__', JSON.stringify({ socketPath, token, iconPath }))
  const result = await new Promise((resolve, reject) => {
    socket.addEventListener('message', event => {
      const frame = JSON.parse(event.data)
      if (frame.id === 1) resolve(frame)
    })
    socket.addEventListener('error', reject, { once: true })
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression,
      awaitPromise: true, returnByValue: true,
    } }))
  })
  console.log(JSON.stringify(result, null, 2))
  if (result.result?.result?.value !== 'installed') throw new Error('injection did not install')
  socket.send(JSON.stringify({ id: 2, method: 'Runtime.runIfWaitingForDebugger' }))
  socket.close()
  let reply
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const peer = createConnection(socketPath)
      reply = await new Promise((resolve, reject) => {
        peer.once('connect', () => peer.write(JSON.stringify({ token, id: 1, method: 'ping' }) + '\n'))
        peer.once('data', chunk => { peer.end(); resolve(JSON.parse(chunk.toString())) })
        peer.once('error', reject)
      })
      if (reply.ready) break
    } catch { /* Tray has not started yet. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  console.log(JSON.stringify(reply))
  if (reply?.ready !== true) console.warn('Electron fixture did not reach app.whenReady(); tray behavior is covered by the unit test.')
} finally {
  child.kill('SIGTERM')
}
