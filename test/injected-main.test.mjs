import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as path from 'node:path'

test('menu bar uses the existing renderer and native approval fails closed by default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-injection-test-'))
  const socketPath = join(directory, 'main.sock')
  const calls = []
  const timers = []
  let visible = true
  let allSpaces = false
  let opacity = 1
  let nativeResponse = 0
  let island
  let cursor = { x: 0, y: 100 }
  let workArea = { x: 0, y: 0, width: 1440, height: 900 }
  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super()
      if (options) {
        island = this
        this.webContents = new EventEmitter()
        this.loadURL = async url => { this.url = url }
        this.setAlwaysOnTop = () => {}
        this.isDestroyed = () => false
        this.close = () => this.emit('closed')
        this.focus = () => {}
      }
    }
    static getAllWindows() { return [window] }
    show() { visible = true; calls.push(['show']) }
    showInactive() { visible = true; calls.push(['showInactive']) }
  }
  const window = Object.assign(new FakeBrowserWindow(), {
    webContents: { getURL: () => 'dsh-app://app/' },
    isDestroyed: () => false, isVisible: () => visible, isFocused: () => false,
    isMinimized: () => false, isFullScreen: () => false,
    getBounds: () => ({ x: 10, y: 20, width: 1280, height: 820 }),
    setBounds: value => calls.push(['bounds', value]),
    getOpacity: () => opacity,
    setOpacity: value => { opacity = value; calls.push(['opacity', value]) },
    setPosition: (x, y) => calls.push(['position', x, y]),
    isVisibleOnAllWorkspaces: () => allSpaces,
    setVisibleOnAllWorkspaces: value => { allSpaces = value; calls.push(['spaces', value]) },
    setAlwaysOnTop: value => calls.push(['top', value]),
    hide: () => { visible = false; calls.push(['hide']) }, focus: () => calls.push(['focus']),
  })
  let tray
  class FakeTray extends EventEmitter {
    constructor() { super(); tray = this }
    setToolTip() {}
    getBounds() { return { x: 100, y: 0, width: 20, height: 20 } }
    popUpContextMenu(menu) { this.menu = menu }
    destroy() { calls.push(['destroy']) }
  }
  const app = Object.assign(new EventEmitter(), {
    setActivationPolicy: policy => calls.push(['activation', policy]),
    whenReady: () => Promise.resolve(), isReady: () => true, getLocale: () => 'en-US', isActive: () => false,
    focus: () => calls.push(['app-focus']), quit: () => {},
  })
  const electron = { app, BrowserWindow: FakeBrowserWindow, Tray: FakeTray,
    systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, resize: () => ({}) }) },
    Menu: { buildFromTemplate: value => value },
    screen: { getDisplayNearestPoint: () => ({ workArea }), getCursorScreenPoint: () => cursor,
      getPrimaryDisplay: () => ({ internal: true, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea }) },
    dialog: { showMessageBox: async () => ({ response: nativeResponse }) },
  }
  const modules = { electron, 'node:net': net, 'node:fs': fs, 'node:path': path,
    'node:inspector': { close() {} } }
  const context = { process: { execPath: '/tmp/fake-electron', getBuiltinModule: () => ({ createRequire: () => name => modules[name] }) },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return { unref() {} } },
    setInterval: (callback, delay) => { timers.push({ callback, delay }); return { unref() {} } },
    clearInterval() {}, console }
  try {
    const source = await readFile(new URL('../injected-main.cjs', import.meta.url), 'utf8')
    const code = source.replace('__DSH_MENU_BAR_CONFIG__', JSON.stringify({ socketPath, token: 'secret', iconPath: '/tmp/icon.png' }))
    assert.equal(vm.runInNewContext(code, context), 'installed')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls[0], ['activation', 'accessory'])
    assert.ok(calls.some(([kind]) => kind === 'hide'))
    window.show()
    window.showInactive()
    assert.equal(calls.some(([kind]) => kind === 'show' || kind === 'showInactive'), false)
    tray.emit('click')
    assert.ok(calls.some(([kind, value]) => kind === 'bounds' && value.width === 1120 && value.height === 850))
    assert.equal(opacity, 0, 'popup starts transparent for its entrance animation')
    assert.equal(allSpaces, true, 'popup joins the current Space without switching desktops')
    assert.ok(calls.some(([kind]) => kind === 'show'))
    assert.ok(calls.findIndex(([kind]) => kind === 'app-focus') > calls.findIndex(([kind]) => kind === 'show'))
    const focusCount = () => calls.filter(([kind]) => kind === 'app-focus').length
    const beforeRetry = focusCount()
    timers.find(timer => timer.delay === 200).callback()
    assert.equal(focusCount(), beforeRetry + 1)
    tray.emit('click')
    assert.ok(calls.some(([kind]) => kind === 'hide'))
    assert.equal(opacity, 1, 'popup restores its original opacity when hidden')
    assert.equal(allSpaces, false, 'window restores its original Space behavior when hidden')
    window.show()
    assert.equal(window.isVisible(), false, 'Desktop cannot reveal a persistent full window after popup closes')
    const afterHide = focusCount()
    timers.filter(timer => timer.delay === 200)[1].callback()
    assert.equal(focusCount(), afterHide)
    workArea = { x: -1024, y: 0, width: 1024, height: 700 }
    tray.emit('click')
    assert.ok(calls.some(([kind, value]) => kind === 'bounds' && value.width === 1000 && value.height === 688
      && value.x >= workArea.x && value.x + value.width <= workArea.x + workArea.width))
    tray.emit('right-click')
    tray.menu[0].click()
    assert.ok(calls.some(([kind, value]) => kind === 'bounds' && value.width === 1280))

    const peer = createConnection(socketPath)
    const reply = await new Promise((resolve, reject) => {
      peer.once('connect', () => peer.write(JSON.stringify({ token: 'secret', id: 1, method: 'approve', toolName: 'bash' }) + '\n'))
      peer.once('data', chunk => resolve(JSON.parse(chunk.toString())))
      peer.once('error', reject)
    })
    assert.equal(reply.outcome, 'rejected')
    nativeResponse = 1
    const review = await new Promise((resolve, reject) => {
      peer.once('data', chunk => resolve(JSON.parse(chunk.toString())))
      peer.once('error', reject)
      peer.write(JSON.stringify({ token: 'secret', id: 2, method: 'approve', toolName: 'bash' }) + '\n')
    })
    assert.equal(review.outcome, 'review')
    const question = await new Promise((resolve, reject) => {
      peer.once('data', chunk => resolve(JSON.parse(chunk.toString())))
      peer.once('error', reject)
      peer.write(JSON.stringify({ token: 'secret', id: 3, method: 'question-approval',
        question: 'Allow app access?', labels: ['Deny', 'Allow for this session'] }) + '\n')
    })
    assert.equal(question.selected, 'Allow for this session')
    const configured = await new Promise(resolve => {
      peer.once('data', chunk => resolve(JSON.parse(chunk.toString())))
      peer.write(JSON.stringify({ token: 'secret', id: 4, method: 'configure', settings: {
        maxWidth: 1120, maxHeight: 850, hideOnBlur: true, hideOnMouseLeave: true,
        notchHover: false, notchApprovals: true, compactApprovals: false, hideTrayIcon: false,
      } }) + '\n')
    })
    assert.equal(configured.configured, true)
    const islandReply = new Promise(resolve => peer.once('data', chunk => resolve(JSON.parse(chunk.toString()))))
    peer.write(JSON.stringify({ token: 'secret', id: 5, method: 'approve', toolName: 'bash', sessionId: 'session-one' }) + '\n')
    for (let attempt = 0; attempt < 100 && !island?.url; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(island?.url.startsWith('data:text/html'))
    const firstIsland = island
    peer.write(JSON.stringify({ token: 'secret', id: 6, method: 'approve', toolName: 'write', sessionId: 'session-two' }) + '\n')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(island, firstIsland)
    island.webContents.emit('will-navigate', { preventDefault() {} }, 'dsh-menu-choice://select/2')
    assert.equal((await islandReply).outcome, 'allowed-once')
    for (let attempt = 0; attempt < 100 && island === firstIsland; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.notEqual(island, firstIsland)
    const secondReply = new Promise(resolve => peer.once('data', chunk => resolve(JSON.parse(chunk.toString()))))
    island.webContents.emit('will-navigate', { preventDefault() {} }, 'dsh-menu-choice://select/0')
    assert.equal((await secondReply).outcome, 'rejected')
    const oldIsland = island
    const previewReply = new Promise(resolve => peer.once('data', chunk => resolve(JSON.parse(chunk.toString()))))
    peer.write(JSON.stringify({ token: 'secret', id: 7, method: 'preview-approval' }) + '\n')
    assert.equal((await previewReply).preview, true)
    assert.notEqual(island, oldIsland)
    let previewClosed = false
    island.on('closed', () => { previewClosed = true })
    island.emit('blur')
    assert.equal(previewClosed, false)
    island.close()
    const hoverConfigured = new Promise(resolve => peer.once('data', chunk => resolve(JSON.parse(chunk.toString()))))
    peer.write(JSON.stringify({ token: 'secret', id: 8, method: 'configure', settings: {
      maxWidth: 1120, maxHeight: 850, hideOnBlur: true, hideOnMouseLeave: true,
      notchHover: true, notchApprovals: false, compactApprovals: false, hideTrayIcon: false,
    } }) + '\n')
    assert.equal((await hoverConfigured).configured, true)
    window.hide()
    cursor = { x: 610, y: 10 }
    timers.find(timer => timer.delay === 120).callback()
    assert.equal(window.isVisible(), true, 'hover opens the original Desktop window')
    window.hide()
    timers.find(timer => timer.delay === 120).callback()
    assert.equal(window.isVisible(), true, 'hover reopens the window while the pointer stays over the island')
    cursor = { x: 2000, y: 900 }
    const leave = timers.filter(timer => timer.delay === 80).at(-1).callback
    leave()
    leave()
    assert.equal(window.isVisible(), false, 'popup closes after the pointer leaves the window and notch')
    peer.end()
  } finally {
    context.__dshMacosMenuBarV1?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
