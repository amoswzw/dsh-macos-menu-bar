import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaults, readSettings, saveSettings, validate } from '../settings.mjs'

test('settings persist per DSH home and keep a reachable entry point', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-menu-settings-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  try {
    assert.deepEqual(await readSettings(), defaults)
    const next = { ...defaults, maxWidth: 1260, notchHover: true, hideTrayIcon: true }
    await saveSettings(next)
    assert.deepEqual(await readSettings(), next)
    assert.throws(() => validate({ ...next, notchHover: false }), /requires notch hover/)
    assert.throws(() => validate({ ...next, maxWidth: 200 }), /Invalid maxWidth/)
    assert.throws(() => validate({ ...next, maxHeight: 480 }), /Invalid maxHeight/)
    assert.throws(() => validate({ ...next, compactApprovals: true }), /require notch approvals/)
    await writeFile(join(directory, 'macos-menu-bar.json'), JSON.stringify({ ...next, maxHeight: 480 }))
    assert.equal((await readSettings()).maxHeight, 600)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(directory, { recursive: true, force: true })
  }
})
