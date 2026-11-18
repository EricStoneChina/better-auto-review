import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'

const ESCALATION_ARGS = {
  path: 'C:/outside/x.txt',
  content: 'hi',
  sandbox_permissions: 'danger-full-access',
  justification: 'write the report the user asked for',
}

const USER_EVENTS = [
  {
    type: 'user/message',
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Please clean up the temp project outside the workspace.' }],
    },
  },
  { type: 'tool/call', data: { name: 'read', arguments: '{"path":"C:/ws/a.txt"}' } },
]

function makeCtx(session, reviewText) {
  const handlers = new Map()
  const log = []
  const ctx = {
    logger: {
      info: (m) => log.push(['info', m]),
      warn: (m) => log.push(['warn', m]),
    },
    permissionPresets: {
      current: (s) => s.preset,
      set: (s, name) => {
        s.preset = name
        log.push(['set', name])
      },
    },
    agents: { list: () => [{ session }] },
    workingDirectory: { ensure: async () => 'C:/ws' },
    approval: {},
    sessions: {},
    tools: {},
    llm: {
      stream: (options) => (async function* () {
        log.push(['llm', options.provider, options.model, options])
        yield { type: 'text-delta', index: 0, text: reviewText }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    },
    on: (name, fn) => {
      handlers.set(name, fn)
      return () => handlers.delete(name)
    },
    effect: (gen) => {
      const it = gen()
      let step = it.next()
      while (!step.done) step = it.next()
      return () => {}
    },
    handler: (name) => handlers.get(name),
    log,
  }
  return ctx
}

function makeSession(events = USER_EVENTS, preset = 'auto-mode') {
  return { id: 's1', preset, snapshotEvents: () => events }
}

function makeExec(session, args, callId = 'call-1') {
  return {
    agent: { session },
    name: 'write',
    arguments: args,
    callId,
    rootCallId: callId,
    signal: new AbortController().signal,
  }
}

function setup(reviewText, config = {}, session = makeSession()) {
  const ctx = makeCtx(session, reviewText)
  apply(ctx, { provider: 'magpie-responses', model: 'codex/gpt-6.2-sol', reasoningEffort: 'medium', ...config })
  return {
    ctx,
    session,
    pre: ctx.handler('tools/pre-execute'),
    approve: ctx.handler('approval/request'),
    llmCalls: () => ctx.log.filter((x) => x[0] === 'llm').length,
  }
}

const allowNext = async () => ({ kind: 'allow' })
const unavailableNext = async () => 'unavailable'

test('allows a sandbox escalation once, then the approval token is consumed', async () => {
  const { pre, approve, llmCalls } = setup('{"decision":"allow"}')
  const exec = makeExec(makeSession(), ESCALATION_ARGS)
  assert.deepEqual(await pre(exec, allowNext), { kind: 'allow' })
  assert.equal(await approve({ agent: exec.agent, toolName: 'write', callId: 'call-1' }, unavailableNext), 'allowed-once')
  assert.equal(await approve({ agent: exec.agent, toolName: 'write', callId: 'call-1' }, unavailableNext), 'unavailable')
  assert.equal(llmCalls(), 1)
})

test('reviewer prompt carries recent user intent, skips system context, and states the repair policy', async () => {
  const events = []
  for (let i = 1; i <= 7; i += 1) {
    events.push({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: `intent-${i}` }] },
    })
    events.push({
      type: 'user/message',
      data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: `SYSTEM-${i}` }] },
    })
  }
  // Harness notices sometimes arrive as source.kind 'user'; they must not crowd
  // the real request out of the recent-intent window.
  for (const notice of [
    'Time sampled while preparing turn 6, step 200: 2026-11-18T16:39:37+08:00[Asia/Singapore]',
    '[system-reminder]\nCurrent DSH file policy: workspace-write.',
    '[Compressed conversation section] — synthetic summary',
    '[folded images: [image: png 10x10 · m00001]]',
  ]) {
    events.push({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: notice }] },
    })
  }
  const { pre, ctx } = setup('{"decision":"allow"}', {}, makeSession(events))
  await pre(makeExec(makeSession(events), ESCALATION_ARGS), allowNext)
  const options = ctx.log.find((entry) => entry[0] === 'llm')[3]
  const prompt = options.messages[0].content[0].text
  assert.match(prompt, /intent-2/)
  assert.match(prompt, /intent-7/)
  assert.doesNotMatch(prompt, /intent-1\b/)
  assert.doesNotMatch(prompt, /SYSTEM-/)
  assert.doesNotMatch(prompt, /Time sampled while preparing turn/)
  assert.doesNotMatch(prompt, /\[system-reminder\]/)
  assert.doesNotMatch(prompt, /Compressed conversation section/)
  assert.match(options.system, /Do not require an explicit phrase authorizing Windows permission changes/)
  assert.match(options.system, /setintegritylevel/)
  assert.match(options.system, /git add and git commit/)
})

test('denies a sandbox escalation with the reviewer reason', async () => {
  const { pre, approve, llmCalls } = setup('{"decision":"deny","reason":"touches secrets"}')
  const exec = makeExec(makeSession(), ESCALATION_ARGS)
  const decision = await pre(exec, allowNext)
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /touches secrets/)
  assert.equal(decision.info.code, 'AUTO_REVIEW_DENIED')
  assert.equal(await approve({ agent: exec.agent, toolName: 'write', callId: 'call-1' }, unavailableNext), 'unavailable')
  assert.equal(llmCalls(), 1)
})

test('does not call the reviewer when the call has no sandbox_permissions', async () => {
  const { pre, llmCalls } = setup('{"decision":"deny"}')
  const exec = makeExec(makeSession(), { path: 'C:/ws/a.txt', content: 'hi' })
  assert.deepEqual(await pre(exec, allowNext), { kind: 'allow' })
  assert.equal(llmCalls(), 0)
})

test('does not call the reviewer for a mode equal to the baseline', async () => {
  const { pre, llmCalls } = setup('{"decision":"deny"}')
  const exec = makeExec(makeSession(), { path: 'C:/ws/a.txt', sandbox_permissions: 'workspace-write' })
  assert.deepEqual(await pre(exec, allowNext), { kind: 'allow' })
  assert.equal(llmCalls(), 0)
})

test('reviews workspace-write when the baseline is read-only', async () => {
  const { pre, llmCalls } = setup('{"decision":"deny"}', { baselineSandbox: 'read-only' })
  const exec = makeExec(makeSession(), { path: 'C:/ws/a.txt', sandbox_permissions: 'workspace-write' })
  assert.equal((await pre(exec, allowNext)).kind, 'deny')
  assert.equal(llmCalls(), 1)
})

test('fails closed when the reviewer output is invalid', async () => {
  const { pre, llmCalls } = setup('not json')
  const decision = await pre(makeExec(makeSession(), ESCALATION_ARGS), allowNext)
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.info.code, 'AUTO_REVIEW_FAILED')
  assert.equal(llmCalls(), 1)
})

test('hands the third consecutive denial to the human', async () => {
  const { pre } = setup('{"decision":"deny","reason":"no"}')
  const session = makeSession()
  const first = await pre(makeExec(session, ESCALATION_ARGS, 'c1'), allowNext)
  const second = await pre(makeExec(session, ESCALATION_ARGS, 'c2'), allowNext)
  const third = await pre(makeExec(session, ESCALATION_ARGS, 'c3'), allowNext)
  assert.equal(first.kind, 'deny')
  assert.equal(second.kind, 'deny')
  assert.equal(third.kind, 'ask')
})

test('ignores sessions that are not on the auto-mode preset', async () => {
  const { pre, llmCalls } = setup('{"decision":"deny"}', {}, makeSession(USER_EVENTS, 'workspace-write'))
  assert.deepEqual(await pre(makeExec(makeSession(USER_EVENTS, 'workspace-write'), ESCALATION_ARGS), allowNext), { kind: 'allow' })
  assert.equal(llmCalls(), 0)
})

test('migrates the built-in auto preset to auto-mode', () => {
  const session = makeSession([], 'auto')
  const ctx = makeCtx(session, '{"decision":"allow"}')
  apply(ctx, {})
  assert.equal(session.preset, 'auto-mode')
})

test('migrates an earlier auto-review session to auto-mode', () => {
  const session = makeSession([], 'auto-review')
  const ctx = makeCtx(session, '{"decision":"allow"}')
  apply(ctx, {})
  assert.equal(session.preset, 'auto-mode')
})
