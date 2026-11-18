import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

test('settings page autosaves changes, linked toggles, and reset', async () => {
  const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8')
  const source = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1]
  assert.ok(source)
  const initial = { maxWidth: 1120, maxHeight: 850, hideOnBlur: true, hideOnMouseLeave: true,
    notchHover: true, notchApprovals: true, compactApprovals: false, hideTrayIcon: true, language: 'auto' }
  const fields = Object.fromEntries(Object.entries(initial).map(([name, value]) => [name, {
    type: typeof value === 'boolean' ? 'checkbox' : typeof value === 'number' ? 'number' : 'select-one',
    value: typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '', checked: Boolean(value),
    listeners: {}, addEventListener(event, listener) { this.listeners[event] = listener },
    checkValidity() { return Number.isInteger(Number(this.value)) && Number(this.value) > 0 },
  }]))
  const status = { textContent: '' }
  const reset = { disabled: true }
  const preview = {}
  const requests = []
  const timers = new Map()
  let nextTimer = 0
  const fetch = async (url, options) => {
    if (options?.method === 'PUT') {
      const settings = JSON.parse(options.body)
      requests.push(settings)
      return { ok: true, json: async () => settings, headers: { get: () => 'true' } }
    }
    assert.equal(url, '/macos-menu-bar/settings')
    return { ok: true, json: async () => initial }
  }
  const context = {
    document: {
      querySelector: selector => fields[/\[name="([^"]+)"\]/u.exec(selector)?.[1]],
      querySelectorAll: () => [], documentElement: { lang: '' }, title: '',
      getElementById: id => ({ status, reset, preview })[id],
    },
    navigator: { language: 'zh-CN' },
    fetch,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id },
    clearTimeout: id => timers.delete(id),
  }
  vm.runInNewContext(source, context)
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const flush = async () => {
    for (const [id, callback] of [...timers]) { timers.delete(id); callback() }
    await settle()
  }
  await settle()
  assert.equal(reset.disabled, false)

  fields.language.value = 'en'
  fields.language.listeners.change()
  await flush()
  assert.equal(requests.at(-1).language, 'en')
  assert.equal(context.document.documentElement.lang, 'en')

  fields.notchHover.checked = false
  fields.notchHover.listeners.change()
  await flush()
  assert.equal(requests.at(-1).notchHover, false)
  assert.equal(requests.at(-1).hideTrayIcon, false)
  assert.equal(status.textContent, 'Saved and applied')

  fields.hideTrayIcon.checked = true
  fields.hideTrayIcon.listeners.change()
  await flush()
  assert.equal(requests.at(-1).notchHover, true)
  assert.equal(requests.at(-1).hideTrayIcon, true)

  fields.compactApprovals.checked = true
  fields.compactApprovals.listeners.change()
  await flush()
  assert.equal(requests.at(-1).compactApprovals, true)
  assert.equal(requests.at(-1).notchApprovals, true)

  reset.onclick()
  await flush()
  assert.deepEqual(requests.at(-1), { maxWidth: 1120, maxHeight: 850, hideOnBlur: true, hideOnMouseLeave: true,
    notchHover: false, notchApprovals: false, compactApprovals: false, hideTrayIcon: false, language: 'auto' })

  fields.compactApprovals.checked = true
  fields.compactApprovals.listeners.change()
  await flush()
  assert.equal(requests.at(-1).notchApprovals, true)
  fields.notchApprovals.checked = false
  fields.notchApprovals.listeners.change()
  await flush()
  assert.equal(requests.at(-1).compactApprovals, false)
})
