/**
 * Browser half of Better Auto Review: the row configuration page under
 * Settings → Plugins → Better Auto Review.
 *
 * The page edits only the reviewer route. Leaving both provider and model
 * empty keeps the 0.1.4 default: the reviewer follows the main agent's current
 * model. The host writes these values back to the profile patch through the
 * native config form, so no manual YAML editing is required.
 */
import { createElement, useEffect, useState } from 'react'

export const name = 'better-auto-review-settings'
export const inject = ['slots']

const ROW_KEY = '@ericstonechina/better-auto-review#better-auto-review'

const LABEL = { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }
const HINT = { margin: '6px 0 0', fontSize: 12, opacity: 0.7, lineHeight: 1.45 }
const INPUT = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 9px',
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,.35)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 13,
  fontFamily: 'inherit',
}
const FIELD = { display: 'grid', gap: 0 }
const ACTIONS = { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }
const BUTTON = {
  padding: '7px 14px',
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,.35)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
}
const PRIMARY = { ...BUTTON, background: 'var(--dsh-accent, #2563eb)', borderColor: 'transparent', color: '#fff' }
const STATUS = { margin: 0, fontSize: 12, opacity: 0.8 }

function readDraft(value) {
  const v = value !== null && typeof value === 'object' ? value : {}
  return {
    provider: typeof v.reviewerProvider === 'string' ? v.reviewerProvider : typeof v.provider === 'string' ? v.provider : '',
    model: typeof v.reviewerModel === 'string' ? v.reviewerModel : typeof v.model === 'string' ? v.model : '',
    effort:
      typeof v.reviewerReasoningEffort === 'string'
        ? v.reviewerReasoningEffort
        : typeof v.reasoningEffort === 'string'
          ? v.reasoningEffort
          : '',
  }
}

function SettingsPage(props) {
  if (!props.form) {
    return createElement('p', { style: STATUS }, '插件配置尚未就绪，请关闭后重新打开。 ')
  }
  return createElement(SettingsEditor, { form: props.form })
}

function SettingsEditor({ form }) {
  const state = form.state || {}
  const [draft, setDraft] = useState(() => readDraft(state.value))
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (dirty) return
    setDraft(readDraft(state.value))
  }, [state.revision, state.status, dirty])

  if (state.status === 'loading') {
    return createElement('p', { style: STATUS, role: 'status' }, '正在读取配置…')
  }
  if (state.status !== 'ready' || state.writable === false) {
    return createElement('p', { style: STATUS, role: 'status' }, '当前配置不可编辑。')
  }

  const edit = (key, value) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setDirty(true)
    setMessage('')
  }

  const save = async () => {
    const provider = draft.provider.trim()
    const model = draft.model.trim()
    if (Boolean(provider) !== Boolean(model)) {
      setMessage('provider 和 model 必须同时填写，或者都留空以跟随主模型。')
      return
    }
    const ops = []
    const put = (key, value) => {
      if (value) ops.push({ op: 'set', path: [key], value })
      else ops.push({ op: 'unset', path: [key] })
    }
    put('reviewerProvider', provider)
    put('reviewerModel', model)
    put('reviewerReasoningEffort', draft.effort)
    // Older versions used these names. Saving the page moves the row to the
    // reviewer* fields so clearing the form really does return to the main model.
    put('provider', '')
    put('model', '')
    put('reasoningEffort', '')
    setBusy(true)
    setMessage('')
    try {
      const accepted = await form.mutate(ops, state.revision)
      setMessage(accepted ? '已保存，下一次审查生效。' : '保存被拒绝，请重试。')
      if (accepted) setDirty(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return createElement(
    'div',
    { style: { display: 'grid', gap: 16, maxWidth: 620, padding: '2px 0' } },
    createElement(
      'div',
      null,
      createElement('h3', { style: { margin: '0 0 6px', fontSize: 15 } }, '审查模型'),
      createElement(
        'p',
        { style: { ...HINT, marginTop: 0 } },
        '留空 provider 和 model 时跟随当前主模型（推荐）。只有要给审查器单独指定模型时才填写；两项必须同时填写。',
      ),
    ),
    createElement(
      'label',
      { style: FIELD },
      createElement('span', { style: LABEL }, 'Provider'),
      createElement('input', {
        style: INPUT,
        value: draft.provider,
        placeholder: '例如 my-provider',
        spellCheck: false,
        onChange: (event) => edit('provider', event.target.value),
      }),
    ),
    createElement(
      'label',
      { style: FIELD },
      createElement('span', { style: LABEL }, 'Model'),
      createElement('input', {
        style: INPUT,
        value: draft.model,
        placeholder: '例如 my-model',
        spellCheck: false,
        onChange: (event) => edit('model', event.target.value),
      }),
    ),
    createElement(
      'label',
      { style: FIELD },
      createElement('span', { style: LABEL }, 'Reasoning effort'),
      createElement(
        'select',
        { style: INPUT, value: draft.effort, onChange: (event) => edit('effort', event.target.value) },
        createElement('option', { value: '' }, '跟随主模型'),
        createElement('option', { value: 'low' }, 'low'),
        createElement('option', { value: 'medium' }, 'medium'),
        createElement('option', { value: 'high' }, 'high'),
      ),
      createElement('p', { style: HINT }, '可留空；显式填写会覆盖审查模型的推理强度。'),
    ),
    createElement(
      'div',
      { style: ACTIONS },
      createElement(
        'button',
        { type: 'button', style: PRIMARY, disabled: busy || !dirty, onClick: save },
        busy ? '保存中…' : '保存',
      ),
      createElement(
        'button',
        {
          type: 'button',
          style: BUTTON,
          disabled: busy || !dirty,
          onClick: () => {
            setDraft(readDraft(state.value))
            setDirty(false)
            setMessage('')
          },
        },
        '重置',
      ),
      message ? createElement('span', { style: STATUS, role: 'status' }, message) : null,
    ),
  )
}

export function apply(ctx) {
  ctx.slots.inject('plugins.row.config', function* () {
    yield ctx.slots.register(
      {
        name: 'plugins.row.config',
        key: ROW_KEY,
        order: 100,
      },
      (props) =>
        props.view === 'summary'
          ? createElement('span', null, '审查模型可在插件设置中调整。')
          : createElement(SettingsPage, props),
    )
  })
}
