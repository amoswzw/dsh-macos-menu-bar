import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export const defaults = Object.freeze({ maxWidth: 1120, maxHeight: 850, hideOnBlur: true,
  hideOnMouseLeave: true, notchHover: false, notchApprovals: false, compactApprovals: false, hideTrayIcon: false,
  language: 'auto' })
const statePath = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'macos-menu-bar.json')

export function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid settings')
  const keys = Object.keys(defaults)
  if (Object.keys(value).some(key => !keys.includes(key))) throw new TypeError('Unknown setting')
  const result = { ...defaults, ...value }
  for (const [key, min, max] of [['maxWidth', 680, 1800], ['maxHeight', 600, 1200]]) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw new TypeError(`Invalid ${key}`)
  }
  for (const key of ['hideOnBlur', 'hideOnMouseLeave', 'notchHover', 'notchApprovals', 'compactApprovals', 'hideTrayIcon']) {
    if (typeof result[key] !== 'boolean') throw new TypeError(`Invalid ${key}`)
  }
  if (!['auto', 'en', 'zh-CN'].includes(result.language)) throw new TypeError('Invalid language')
  if (result.hideTrayIcon && !result.notchHover) throw new TypeError('Hiding the menu icon requires notch hover')
  if (result.compactApprovals && !result.notchApprovals) throw new TypeError('Compact approvals require notch approvals')
  return result
}

export async function readSettings() {
  try {
    const stored = JSON.parse(await readFile(statePath(), 'utf8'))
    if (Number.isInteger(stored.maxHeight) && stored.maxHeight >= 480 && stored.maxHeight < 600) stored.maxHeight = 600
    return validate(stored)
  }
  catch (error) { if (error.code === 'ENOENT') return { ...defaults }; throw error }
}

export async function saveSettings(value) {
  const next = validate(value)
  const file = statePath()
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, file)
  return next
}
