import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createConnection } from 'node:net'
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

async function fixture() {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'dsh-notch-state-'))
  const socketPath = path.join(directory, 'main.sock')
  let visible = false
  let islandVisible = false
  let indicator = 0
  let tray
  let cursor = { x: 0, y: 800 }
  let approvalId
  let approvalShown
  const whenApprovalShown = new Promise(resolve => { approvalShown = resolve })
  const nativeEvents = []
  const timers = new Map()
  const display = { internal: true, bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 24, width: 1440, height: 876 } }
  class Window extends EventEmitter {
    static getAllWindows() { return [window] }
    show() { visible = true }
    showInactive() { visible = true }
  }
  const window = Object.assign(new Window(), {
    webContents: { getURL: () => 'dsh-app://app/' }, isDestroyed: () => false,
    isVisible: () => visible, isFocused: () => true, isMinimized: () => false,
    isFullScreen: () => false, getBounds: () => ({ x: 0, y: 24, width: 1000, height: 700 }),
    setBounds() {}, setAlwaysOnTop() {}, setVisibleOnAllWorkspaces() {},
    hide() { visible = false }, focus() {},
  })
  class Tray extends EventEmitter {
    constructor() { super(); tray = this }
    setToolTip() {}
    getBounds() { return { x: 100, y: 0, width: 20, height: 24 } }
    popUpContextMenu(menu) { this.menu = menu }
    destroy() {}
  }
  const app = Object.assign(new EventEmitter(), { whenReady: async () => {}, isReady: () => true,
    isActive: () => true, setActivationPolicy() {}, focus() {}, getLocale: () => 'en' })
  const native = { metrics: () => ({ available: 1, width: 240, height: 24 }),
    setIndicator(state) { indicator = state }, showIsland() { islandVisible = true },
    hideIsland() { islandVisible = false }, hideApproval() {},
    showApproval(title, message, buttons, preview, id) { approvalId = id; approvalShown() },
    updateApprovalQueue() {}, pollEvents: () => nativeEvents.shift() || {} }
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => display,
    getDisplayNearestPoint: () => display, getCursorScreenPoint: () => cursor })
  const modules = { electron: { app, BrowserWindow: Window, Tray,
    dialog: { showMessageBox() {} }, Menu: { buildFromTemplate: menu => menu },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, resize() {} }) },
    screen },
    native, 'node:net': net, 'node:fs': fs, 'node:path': path, 'node:inspector': { close() {} } }
  const timer = () => ({ unref() {} })
  const context = { process: { execPath: '/tmp/electron',
    getBuiltinModule: () => ({ createRequire: () => name => modules[name] }) },
    setTimeout: timer, setInterval(callback, delay) { const id = timer(); timers.set(id, { callback, delay }); return id },
    clearInterval(id) { timers.delete(id) }, console }
  const source = fs.readFileSync(new URL('../injected-main.cjs', import.meta.url), 'utf8')
  vm.runInNewContext(source.replace('__DSH_MENU_BAR_CONFIG__', JSON.stringify({
    socketPath, token: 'secret', addonPath: 'native', iconPath: '/tmp/icon.png',
  })), context)
  await new Promise(resolve => setImmediate(resolve))
  const peer = createConnection(socketPath)
  await new Promise((resolve, reject) => { peer.once('connect', resolve); peer.once('error', reject) })
  let id = 0
  const request = (method, details = {}) => new Promise(resolve => {
    peer.once('data', chunk => resolve(JSON.parse(chunk.toString())))
    peer.write(JSON.stringify({ token: 'secret', id: ++id, method, ...details }) + '\n')
  })
  return { request, window, whenApprovalShown,
    hover() { cursor = { x: 720, y: 10 }; for (const entry of [...timers.values()]) if (entry.delay === 120) entry.callback() },
    displayChanged() { screen.emit('display-metrics-changed') },
    chooseApproval(choice) {
      assert.ok(approvalId, 'native approval was shown')
      nativeEvents.push({ approvalId, choice })
      for (const entry of [...timers.values()]) if (entry.delay === 80) entry.callback()
    },
    open: () => tray.emit('click'),
    openFull() { tray.emit('right-click'); tray.menu[0].click() },
    state: () => ({ visible, islandVisible, indicator }),
    async configure(hideWhenIdle, extra = {}) {
      await request('configure', { settings: { maxWidth: 1120, maxHeight: 850,
        hideOnBlur: true, hideOnMouseLeave: true, notchHover: true, notchApprovals: false,
        compactApprovals: false, hideTrayIcon: false, hideWhenIdle, language: 'en', ...extra } })
    },
    async close() {
      peer.destroy()
      context.__dshMacosMenuBarV1.dispose()
      await new Promise(resolve => setImmediate(resolve))
      fs.rmSync(directory, { recursive: true, force: true })
    } }
}

test('completion is green independently of auto-hide settings', async () => {
  const h = await fixture()
  try {
    await h.configure(false)
    await h.request('activity', { runningCount: 1 })
    assert.equal(h.state().indicator, 1, 'executing tasks are blue')
    await h.request('activity', { runningCount: 0 })
    assert.equal(h.state().indicator, 3, 'completed tasks are green')
  } finally { await h.close() }
})

test('opening an idle completion hides the island; executing tasks keep it visible', async () => {
  const h = await fixture()
  try {
    await h.configure(true)
    await h.request('activity', { runningCount: 2 })
    h.open()
    assert.equal(h.state().islandVisible, true)
    await h.request('activity', { runningCount: 1 })
    assert.equal(h.state().indicator, 1, 'another executing task keeps the light blue')
    h.window.emit('blur')
    await h.request('activity', { runningCount: 0 })
    assert.equal(h.state().indicator, 3)
    assert.equal(h.state().islandVisible, true, 'completion remains visible until viewed')
    h.open()
    assert.equal(h.state().visible, true)
    assert.equal(h.state().islandVisible, false, 'opening acknowledges an idle completion')
    h.window.emit('blur')
    assert.equal(h.state().islandVisible, false)
    await h.request('activity', { runningCount: 1 })
    assert.equal(h.state().islandVisible, true, 'new work restores the island')
    assert.equal(h.state().indicator, 1)
    await h.request('activity', { runningCount: 0 })
    assert.equal(h.state().islandVisible, true)
    h.openFull()
    assert.equal(h.state().islandVisible, false, 'the full window also acknowledges completion')
  } finally { await h.close() }
})

test('completion while the popup is visible does not leave an unread green light', async () => {
  const h = await fixture()
  try {
    await h.configure(true)
    await h.request('activity', { runningCount: 1 })
    h.open()
    await h.request('activity', { runningCount: 0 })
    h.window.emit('blur')
    assert.equal(h.state().islandVisible, false)
  } finally { await h.close() }
})


test('a hidden island remains reachable by hover and follows setting changes', async () => {
  const h = await fixture()
  try {
    await h.configure(true)
    h.open()
    h.window.emit('blur')
    assert.equal(h.state().islandVisible, false)
    h.displayChanged()
    assert.equal(h.state().islandVisible, false, 'display changes preserve idle hiding')
    h.hover()
    assert.equal(h.state().visible, true, 'hover works even when the island is hidden')
    h.window.emit('blur')
    await h.configure(false)
    assert.equal(h.state().islandVisible, true, 'disabling auto-hide restores the island')
    h.open()
    assert.equal(h.state().islandVisible, true, 'auto-hide disabled keeps the island visible')
    await h.configure(true)
    assert.equal(h.state().islandVisible, false, 'enabling auto-hide applies immediately')
  } finally { await h.close() }
})

test('pending approvals stay orange and restore idle hiding after resolution', async () => {
  const h = await fixture()
  try {
    await h.configure(true, { notchApprovals: true })
    h.open()
    h.window.emit('blur')
    const approval = h.request('approve', { toolName: 'bash' })
    await h.whenApprovalShown
    assert.equal(h.state().indicator, 2)
    assert.equal(h.state().islandVisible, true, 'pending approval prevents idle hiding')
    h.chooseApproval(0)
    assert.equal((await approval).outcome, 'rejected')
    assert.equal(h.state().islandVisible, false, 'resolving the last approval restores idle hiding')
  } finally { await h.close() }
})
