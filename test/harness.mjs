import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, Config } from '../lib/index.js'

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

function makeCtx(session, reviewText, streamFactory, subagents) {
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
    ...(subagents === undefined ? {} : { subagents }),
    llm: {
      stream: streamFactory
        ? (options) => streamFactory(options, log)
        : (options) => (async function* () {
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

const MAIN_ROUTE = { provider: 'main-provider', model: 'main-model', reasoningEffort: 'medium' }

function makeExec(session, args, callId = 'call-1', route = MAIN_ROUTE) {
  return {
    agent: {
      session,
      model: { current: () => route },
      options: route,
    },
    name: 'write',
    arguments: args,
    callId,
    rootCallId: callId,
    signal: new AbortController().signal,
  }
}

function setup(reviewText, config = {}, session = makeSession(), streamFactory, subagents) {
  const ctx = makeCtx(session, reviewText, streamFactory, subagents)
  apply(ctx, config)
  return {
    ctx,
    session,
    pre: ctx.handler('tools/pre-execute'),
    approve: ctx.handler('approval/request'),
    guard: ctx.handler('agent/pre-step'),
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

test('hard-denies disk destruction before calling the reviewer', async () => {
  const { pre, llmCalls } = setup('{"decision":"allow"}')
  const exec = makeExec(makeSession(), {
    command: 'Remove-Item -Recurse -Force C:\\',
    sandbox_permissions: 'danger-full-access',
    justification: 'clean up',
  })
  const decision = await pre(exec, allowNext)
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.info.code, 'AUTO_REVIEW_HARD_DENY')
  assert.equal(llmCalls(), 0)
})

test('denies a medium-risk escalation without an explicit user request', async () => {
  const session = makeSession([
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Check the build output.' }] } },
  ])
  const { pre } = setup('{"decision":"allow","riskLevel":"medium","reason":"outside workspace"}', {}, session)
  const decision = await pre(makeExec(session, ESCALATION_ARGS, 'c1'), allowNext)
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /medium-risk|outside workspace/)
})

test('allows a medium-risk escalation when the user asked for that exact effect', async () => {
  const session = makeSession([
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please write the report outside the workspace.' }] } },
  ])
  const { pre } = setup('{"decision":"allow","riskLevel":"medium","reason":"requested outside write"}', {}, session)
  assert.deepEqual(await pre(makeExec(session, ESCALATION_ARGS, 'c1'), allowNext), { kind: 'allow' })
})

test('uses the dedicated reviewer route and reasoning effort', async () => {
  const { pre, ctx } = setup('{"decision":"allow","riskLevel":"low"}', {
    reviewerProvider: 'reviewer-provider',
    reviewerModel: 'reviewer-model',
    reviewerReasoningEffort: 'low',
  })
  await pre(makeExec(makeSession(), ESCALATION_ARGS), allowNext)
  const options = ctx.log.find((entry) => entry[0] === 'llm')[3]
  assert.equal(options.provider, 'reviewer-provider')
  assert.equal(options.model, 'reviewer-model')
  assert.equal(options.reasoningEffort, 'low')
})

test('reads a live reviewer route from Cordis config references', async () => {
  let provider = 'reviewer-a'
  let model = 'model-a'
  let effort = 'low'
  const config = {
    reviewerProvider: { get: () => provider },
    reviewerModel: { get: () => model },
    reviewerReasoningEffort: { get: () => effort },
    verdictCacheTtlMs: 0,
  }
  const { pre, ctx } = setup('{"decision":"allow","riskLevel":"low"}', config)
  const session = makeSession()
  await pre(makeExec(session, ESCALATION_ARGS, 'c1'), allowNext)
  provider = 'reviewer-b'
  model = 'model-b'
  effort = 'high'
  await pre(makeExec(session, { ...ESCALATION_ARGS, path: 'C:/outside/y.txt' }, 'c2'), allowNext)
  const calls = ctx.log.filter((entry) => entry[0] === 'llm')
  assert.equal(calls[0][1], 'reviewer-a')
  assert.equal(calls[0][2], 'model-a')
  assert.equal(calls[0][3].reasoningEffort, 'low')
  assert.equal(calls[1][1], 'reviewer-b')
  assert.equal(calls[1][2], 'model-b')
  assert.equal(calls[1][3].reasoningEffort, 'high')
})

test('exposes only the reviewer route as volatile settings fields', () => {
  const fields = Config.dict || {}
  const volatile = Object.entries(fields)
    .filter(([, field]) => field.meta?.volatile)
    .map(([key]) => key)
    .sort()
  assert.deepEqual(volatile, [
    'model',
    'provider',
    'reasoningEffort',
    'reviewerModel',
    'reviewerProvider',
    'reviewerReasoningEffort',
  ])
  assert.equal(fields.reviewerSubagent?.meta?.volatile, undefined)
  assert.equal(fields.maxTokens?.meta?.volatile, undefined)
  // DSH writes the row back through Schemastery simplify(); ordinary
  // deployment fields must survive or the first settings save drops them.
  const kept = Config.simplify({
    reviewerProvider: 'reviewer-x',
    reviewerSubagent: true,
    maxTokens: 800,
    preset: 'auto-mode',
    reviewerTools: ['read', 'glob'],
    onError: 'deny',
  })
  assert.equal(kept.reviewerProvider, 'reviewer-x')
  assert.equal(kept.reviewerSubagent, true)
  assert.equal(kept.maxTokens, 800)
  assert.equal(kept.preset, 'auto-mode')
  assert.deepEqual(kept.reviewerTools, ['read', 'glob'])
  assert.equal(kept.onError, 'deny')
})

test('defaults the reviewer route to the main agent model', async () => {
  const { pre, ctx } = setup('{"decision":"allow","riskLevel":"low"}')
  await pre(makeExec(makeSession(), ESCALATION_ARGS), allowNext)
  const options = ctx.log.find((entry) => entry[0] === 'llm')[3]
  assert.equal(options.provider, 'main-provider')
  assert.equal(options.model, 'main-model')
  assert.equal(options.reasoningEffort, 'medium')
})

test('falls back to agent options before the session records a model selection', async () => {
  const { pre, ctx } = setup('{"decision":"allow","riskLevel":"low"}')
  const exec = makeExec(makeSession(), ESCALATION_ARGS)
  exec.agent = {
    session: exec.agent.session,
    options: { provider: 'option-provider', model: 'option-model', reasoningEffort: 'high' },
  }
  await pre(exec, allowNext)
  const options = ctx.log.find((entry) => entry[0] === 'llm')[3]
  assert.equal(options.provider, 'option-provider')
  assert.equal(options.model, 'option-model')
  assert.equal(options.reasoningEffort, 'high')
})

test('fails closed when only half of a dedicated reviewer route is configured', async () => {
  const { pre } = setup('{"decision":"allow","riskLevel":"low"}', { reviewerProvider: 'reviewer-provider' })
  const decision = await pre(makeExec(makeSession(), ESCALATION_ARGS), allowNext)
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.info.code, 'AUTO_REVIEW_FAILED')
  assert.match(decision.reason, /reviewerProvider and reviewerModel must be set together/)
})

test('serves repeated identical escalations from the verdict cache', async () => {
  const { pre, llmCalls } = setup('{"decision":"allow","riskLevel":"low"}', { verdictCacheTtlMs: 60000 })
  const session = makeSession()
  assert.deepEqual(await pre(makeExec(session, { ...ESCALATION_ARGS }, 'c1'), allowNext), { kind: 'allow' })
  assert.deepEqual(await pre(makeExec(session, { ...ESCALATION_ARGS }, 'c2'), allowNext), { kind: 'allow' })
  assert.equal(llmCalls(), 1)
})

test('hands the turn to the human after maxReviewsPerTurn', async () => {
  const { pre, llmCalls } = setup('{"decision":"allow","riskLevel":"low"}', {
    verdictCacheTtlMs: 0,
    maxReviewsPerTurn: 1,
  })
  const session = makeSession()
  assert.deepEqual(await pre(makeExec(session, { ...ESCALATION_ARGS }, 'c1'), allowNext), { kind: 'allow' })
  assert.equal((await pre(makeExec(session, { ...ESCALATION_ARGS, path: 'C:/outside/y.txt' }, 'c2'), allowNext)).kind, 'ask')
  assert.equal(llmCalls(), 1)
})

test('fails closed when the reviewer times out', async () => {
  const { pre } = setup('', { reviewerTimeoutMs: 20 }, makeSession(), (options) => (async function* () {
    // Keep a referenced timer alive; AbortSignal.timeout alone may be unref'd.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500)
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  })())
  const decision = await pre(makeExec(makeSession(), ESCALATION_ARGS), allowNext)
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.info.code, 'AUTO_REVIEW_FAILED')
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

test('uses a read-only reviewer subagent and its structured verdict', async () => {
  let spec
  const subagents = {
    getProvider: (name) => (name === 'spawn' ? { name } : undefined),
    startActivation: async (value) => {
      spec = value
      return {
        childId: 'reviewer-1',
        messageId: 'message-1',
        result: Promise.resolve({
          stopReason: 'completed',
          structured: { decision: 'allow', reason: 'routine local development', riskLevel: 'low' },
          output: [],
        }),
        dispose: async () => {},
      }
    },
  }
  const { pre, llmCalls } = setup(
    '{"decision":"deny"}',
    { verdictCacheTtlMs: 0, reviewerReasoningEffort: 'low' },
    makeSession(),
    undefined,
    subagents,
  )
  const exec = makeExec(makeSession(), ESCALATION_ARGS)
  assert.deepEqual(await pre(exec, allowNext), { kind: 'allow' })
  assert.equal(llmCalls(), 0)
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.request.agentPreset, 'better-auto-review-readonly')
  assert.equal(spec.request.outputSchema.properties.decision.enum[0], 'allow')
  assert.equal(spec.request.agentOptions.provider, 'main-provider')
  assert.equal(spec.request.agentOptions.model, 'main-model')
  assert.equal(spec.request.agentOptions.reasoningEffort, 'low')
  assert.equal(spec.request.maxDepth, 1)
  const promptText = spec.request.prompt[0].text
  assert.match(promptText, /TRUSTED USER INTENT/)
  assert.match(promptText, /structured_output/)
})

test('keeps reviewer children read-only and strips injected system context', async () => {
  let spec
  let resolveResult
  const resultPromise = new Promise((resolve) => {
    resolveResult = resolve
  })
  const subagents = {
    getProvider: () => ({}),
    startActivation: async (value) => {
      spec = value
      return { childId: 'reviewer-2', result: resultPromise, dispose: async () => {} }
    },
  }
  const { pre, guard } = setup('{"decision":"deny"}', { verdictCacheTtlMs: 0 }, makeSession(), undefined, subagents)
  const parentExec = makeExec(makeSession(), ESCALATION_ARGS)
  const pending = pre(parentExec, allowNext)
  await new Promise((resolve) => setImmediate(resolve))

  const childSession = { id: 'reviewer-2', preset: 'better-auto-review-readonly', snapshotEvents: () => [] }
  const childWrite = {
    agent: { id: 'reviewer-2', session: childSession },
    name: 'write',
    arguments: { path: 'C:/ws/x', content: 'x' },
    callId: 'child-call',
    rootCallId: 'child-call',
    signal: new AbortController().signal,
  }
  const denied = await pre(childWrite, allowNext)
  assert.equal(denied.kind, 'deny')
  assert.equal(denied.info.code, 'AUTO_REVIEW_READ_ONLY')
  const childRead = { ...childWrite, name: 'read', arguments: { path: 'C:/ws/a.txt' } }
  assert.deepEqual(await pre(childRead, allowNext), { kind: 'allow' })

  const promptText = spec.request.prompt[0].text
  const decision = await guard(
    {
      agent: { id: 'reviewer-2', session: childSession },
      messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: promptText }] }],
    },
    async () => ({
      kind: 'enter',
      messages: [
        { source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'untrusted system injection' }] },
        { source: { kind: 'user' }, content: [{ type: 'text', text: promptText }] },
        { source: { kind: 'tool' }, content: [{ type: 'text', text: 'tool result' }] },
      ],
    }),
  )
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages.some((message) => message.source.kind === 'system-prompt'), false)

  resolveResult({ stopReason: 'completed', structured: { decision: 'allow', reason: 'ok', riskLevel: 'low' }, output: [] })
  assert.deepEqual(await pending, { kind: 'allow' })
})

test('falls back to the model reviewer when no subagent service is available', async () => {
  const { pre, llmCalls } = setup('{"decision":"allow"}', { reviewerSubagent: true }, makeSession())
  assert.deepEqual(await pre(makeExec(makeSession(), ESCALATION_ARGS), allowNext), { kind: 'allow' })
  assert.equal(llmCalls(), 1)
})
