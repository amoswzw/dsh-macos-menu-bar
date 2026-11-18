import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, isLocalRequest } from '../index.mjs'

test('settings routes accept only a local Desktop connection', () => {
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLocalRequest({ socket: { remoteAddress } }), true)
  }
  for (const remoteAddress of ['192.168.1.4', '10.0.0.2', '::ffff:192.168.1.4', undefined]) {
    assert.equal(isLocalRequest({ socket: { remoteAddress } }), false)
  }
})

test('remote clients cannot load settings or trigger an approval preview', async () => {
  const routes = new Map()
  const ctx = {
    webServer: { register(route) { routes.set(route.path, route); return () => {} } },
    effect(register) { register() },
  }
  await apply(ctx)
  assert.equal(routes.size, 3)
  for (const [path, method] of [
    ['/macos-menu-bar/settings.html', 'GET'],
    ['/macos-menu-bar/settings', 'GET'],
    ['/macos-menu-bar/settings', 'PUT'],
    ['/macos-menu-bar/preview-approval', 'POST'],
  ]) {
    let status
    let ended = false
    await routes.get(path).handler({ method, socket: { remoteAddress: '192.168.1.4' } }, {
      writeHead(code) { status = code }, end() { ended = true },
    })
    assert.equal(status, 403, `${method} ${path}`)
    assert.equal(ended, true)
  }
})
