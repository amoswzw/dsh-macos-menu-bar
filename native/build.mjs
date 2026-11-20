import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const source = fileURLToPath(new URL('./notch-panel.mm', import.meta.url))

export async function nativeAddonPath() {
  if (process.platform !== 'darwin') return undefined
  const content = await readFile(source)
  const hash = createHash('sha256').update(content).update(process.arch).digest('hex').slice(0, 16)
  // Desktop sandboxes plugin processes to the workspace plus platform temporary
  // areas, so build artifacts must live in the temporary directory tree.
  const directory = join(tmpdir(), 'dsh-macos-menu-bar')
  const target = join(directory, `notch-panel-${hash}.node`)
  try { await stat(target); return target } catch { /* Build once per source and architecture. */ }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${hash}-${process.pid}.node`)
  try {
    await exec('clang++', ['-std=c++17', '-fobjc-arc', '-dynamiclib', '-undefined', 'dynamic_lookup',
      '-framework', 'AppKit', '-framework', 'CoreGraphics', '-framework', 'QuartzCore',
      '-o', temporary, source], { timeout: 30000 })
    await rename(temporary, target)
    return target
  } finally { await unlink(temporary).catch(() => undefined) }
}
