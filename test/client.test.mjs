import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

test('review opens the exact session named by each approval', async () => {
  const listeners = new Map()
  const opened = []
  let plugin
  const window = {
    __dshMacosMenuBarPendingReviewSession: 'session-before-load',
    __ModuleLoader__: { load(definition) { plugin = definition.factory(() => ({ createElement() {} })) } },
    addEventListener(name, listener) { listeners.set(name, listener) },
    removeEventListener(name) { listeners.delete(name) },
    localStorage: { getItem() { return null } },
    navigator: { language: 'en' },
  }
  const cleanups = []
  const slots = { inject() { return () => {} }, register() { return () => {} } }
  const ctx = {
    get(name) {
      if (name === 'uiWorkspace') return { openSession(sessionId) { opened.push(sessionId) } }
      if (name === 'slots') return slots
    },
    effect(register) { cleanups.push(register()) },
  }
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, { window, setTimeout, clearTimeout, console })
  assert.equal(Array.from(plugin.inject).join(','), 'uiWorkspace')
  plugin.apply(ctx)
  assert.deepEqual(opened, ['session-before-load'])
  assert.equal(window.__dshMacosMenuBarPendingReviewSession, undefined)
  listeners.get('dsh-macos-menu-bar:review-session')({ detail: 'session-first' })
  listeners.get('dsh-macos-menu-bar:review-session')({ detail: 'session-second' })
  assert.deepEqual(opened, ['session-before-load', 'session-first', 'session-second'])
  for (const cleanup of cleanups) cleanup?.()
  assert.equal(listeners.has('dsh-macos-menu-bar:review-session'), false)
})
