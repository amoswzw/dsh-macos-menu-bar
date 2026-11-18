import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.mjs'

async function fixture(onApproval) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-menu-test-'))
  const socketPath = join(directory, 'main.sock')
  const activities = []
  const server = createServer(peer => {
    peer.setEncoding('utf8')
    let input = ''
    peer.on('data', chunk => {
      input += chunk
      let newline
      while ((newline = input.indexOf('\n')) !== -1) {
        const line = input.slice(0, newline)
        input = input.slice(newline + 1)
        const request = JSON.parse(line)
        if (request.method === 'ping') peer.write(JSON.stringify({ id: request.id, ready: true }) + '\n')
        else if (request.method === 'configure') peer.write(JSON.stringify({ id: request.id, configured: true }) + '\n')
        else if (request.method === 'activity') {
          activities.push(request.runningCount)
          peer.write(JSON.stringify({ id: request.id, updated: true }) + '\n')
        }
        else if (request.method === 'approve' || request.method === 'question-approval') onApproval(request, peer)
        else if (request.method === 'dispose') peer.write(JSON.stringify({ id: request.id, disposed: true }) + '\n')
      }
    })
  })
  await new Promise(resolve => server.listen(socketPath, resolve))
  const previous = { socket: process.env.DSH_MENU_BAR_SOCKET, token: process.env.DSH_MENU_BAR_TOKEN }
  process.env.DSH_MENU_BAR_SOCKET = socketPath
  process.env.DSH_MENU_BAR_TOKEN = 'test-token'
  const ctx = { listener: undefined, questionListener: undefined, sessionEvent: undefined,
    cleanup: undefined, agentListeners: new Map(),
    get(name) { return name === 'agents' ? { list: () => [] } : undefined },
    webServer: { register() { return () => {} } },
    effect(cleanup, label) { const stop = cleanup(); if (label === 'macos-menu-bar: native connection') this.cleanup = stop },
    on(name, listener, options) {
      if (name.startsWith('agent/')) this.agentListeners.set(name, listener)
      else if (name === 'session/event') {
        assert.equal(options.global, true)
        this.sessionEvent = listener
      }
      else {
        assert.equal(options.prepend, true)
        if (name === 'approval/request') this.listener = listener
        else if (name === 'user-questions/request') this.questionListener = listener
        else throw new Error(`unexpected event: ${name}`)
      }
    },
  }
  return { ctx, activities, async close() {
    await ctx.cleanup?.()
    await new Promise(resolve => server.close(resolve))
    if (previous.socket === undefined) delete process.env.DSH_MENU_BAR_SOCKET
    else process.env.DSH_MENU_BAR_SOCKET = previous.socket
    if (previous.token === undefined) delete process.env.DSH_MENU_BAR_TOKEN
    else process.env.DSH_MENU_BAR_TOKEN = previous.token
    await rm(directory, { recursive: true, force: true })
  } }
}

test('indicator follows actual agent status changes', async () => {
  const harness = await fixture(() => {})
  const agent = { status: 'idle' }
  harness.ctx.get = name => name === 'agents' ? { list: () => [agent] } : undefined
  try {
    await apply(harness.ctx)
    agent.status = 'running'
    harness.ctx.agentListeners.get('agent/status')({ agent, status: 'running' })
    agent.status = 'idle'
    harness.ctx.agentListeners.get('agent/status')({ agent, status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(harness.activities, [0, 1, 0])
  } finally { await harness.close() }
})

test('approval card receives the correlated command and localized reason', async () => {
  const harness = await fixture((request, peer) => {
    assert.equal(request.command, 'echo hello')
    assert.deepEqual(request.displayReason, { en: 'Run a command', zh: '执行命令' })
    peer.write(JSON.stringify({ id: request.id, outcome: 'rejected' }) + '\n')
  })
  try {
    await apply(harness.ctx)
    harness.ctx.sessionEvent({ id: 'session-a' }, { type: 'tool/call', data: {
      name: 'bash', callId: 'call-a', arguments: JSON.stringify({ command: 'echo hello' }),
    } })
    const result = await harness.ctx.listener({ toolName: 'bash', callId: 'call-a',
      agent: { session: { id: 'session-a' } }, displayReason: { en: 'Run a command', zh: '执行命令' },
    })
    assert.equal(result, 'rejected')
  } finally { await harness.close() }
})

test('native approval grants only the response for its request', async () => {
  const harness = await fixture((request, peer) => {
    assert.equal(request.toolName, 'bash')
    peer.write(JSON.stringify({ id: request.id, outcome: 'allowed-once' }) + '\n')
  })
  try {
    await apply(harness.ctx)
    assert.equal(await harness.ctx.listener({ toolName: 'bash' }), 'allowed-once')
  } finally { await harness.close() }
})

test('cancellation ignores a late native grant', async () => {
  let reply
  const harness = await fixture((request, peer) => { reply = () => peer.write(JSON.stringify({ id: request.id, outcome: 'allowed-once' }) + '\n') })
  try {
    await apply(harness.ctx)
    const controller = new AbortController()
    const decision = harness.ctx.listener({ toolName: 'bash', signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort()
    assert.equal(await decision, 'cancelled')
    reply()
  } finally { await harness.close() }
})

test('review details delegates to the existing Desktop approval UI', async () => {
  const harness = await fixture((request, peer) => {
    peer.write(JSON.stringify({ id: request.id, outcome: 'review' }) + '\n')
  })
  try {
    await apply(harness.ctx)
    let delegated = 0
    const outcome = await harness.ctx.listener({ toolName: 'bash' }, async () => {
      delegated++
      return 'rejected'
    })
    assert.equal(outcome, 'rejected')
    assert.equal(delegated, 1)
  } finally { await harness.close() }
})

test('application approval intent returns the exact declared option label', async () => {
  const harness = await fixture((request, peer) => {
    assert.equal(request.method, 'question-approval')
    assert.deepEqual(request.labels, ['Deny', 'Allow for this session', 'Always allow'])
    peer.write(JSON.stringify({ id: request.id, selected: 'Always allow' }) + '\n')
  })
  try {
    await apply(harness.ctx)
    const answer = await harness.ctx.questionListener({ questions: [{
      id: 'app-access', question: 'Allow access?', options: [],
      intent: { kind: 'approval', reject: 'Deny', approve: 'Allow for this session', always: 'Always allow' },
    }] }, async () => { throw new Error('native answer should claim this request') })
    assert.deepEqual(answer, { answers: [{ id: 'app-access', selected: ['Always allow'] }] })
  } finally { await harness.close() }
})

test('cancelled application approval cannot become a late native grant', async () => {
  let reply
  const harness = await fixture((request, peer) => {
    reply = () => peer.write(JSON.stringify({ id: request.id, selected: 'Allow' }) + '\n')
  })
  try {
    await apply(harness.ctx)
    const controller = new AbortController()
    let delegated = false
    const decision = harness.ctx.questionListener({ signal: controller.signal, questions: [{
      id: 'app-access', question: 'Allow access?', detail: 'Exact scope', options: [],
      intent: { kind: 'approval', reject: 'Deny', approve: 'Allow' },
    }] }, async () => { delegated = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort()
    await assert.rejects(decision, { name: 'AbortError' })
    reply()
    assert.equal(delegated, false)
  } finally { await harness.close() }
})
