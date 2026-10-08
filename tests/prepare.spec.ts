import { describe, expect, it } from 'vitest'
import { classifyUpstreamError, prepareChatBody, prepareCnChatBody, prepareInternationalChatBody, regionOf } from '../src/upstream.ts'

describe('prepareChatBody', () => {
  it('forces stream true', () => {
    expect(JSON.parse(prepareChatBody('{"model":"auto","messages":[]}'))['stream']).toBe(true)
  })

  it('keeps invalid JSON untouched', () => {
    expect(prepareChatBody('not json')).toBe('not json')
  })

  it('flattens object tool_choice auto', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({ tool_choice: { type: 'auto' } })))
    expect(body['tool_choice']).toBe('auto')
  })

  it('passes `reasoning_effort` through verbatim, including the adapter\'s own `off`', () => {
    // `prepareChatBody` is shared by both regions and deliberately keeps its
    // hands off `reasoning_effort`: it normalises the wire shape, not the
    // effort. Since #87 the strip runs one layer down on *both* region paths —
    // `prepareCnChatBody` and `prepareInternationalChatBody` each call
    // `dropUnsupportedEffort` — so `off` reaches neither upstream. The two
    // paths stay separate because the bodies otherwise differ: only the
    // international one prepends a system prompt. See the specs below and the
    // chatStream-level spec in upstream.spec.ts.
    for (const effort of ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'none']) {
      const body = JSON.parse(prepareChatBody(JSON.stringify({ messages: [], reasoning_effort: effort })))
      expect(body['reasoning_effort']).toBe(effort)
    }
  })

  it('flattens named function tool_choice to the function name', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      tool_choice: { type: 'function', function: { name: 'grep' } },
    })))
    expect(body['tool_choice']).toBe('grep')
  })

  it('drops tool_choice and tools for none', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      tool_choice: { type: 'none' },
      tools: [{ type: 'function', function: { name: 'grep' } }],
    })))
    expect('tool_choice' in body).toBe(false)
    expect('tools' in body).toBe(false)
  })

  it('drops an unrecognized object tool_choice', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({ tool_choice: { type: 'weird' } })))
    expect('tool_choice' in body).toBe(false)
  })

  it('preserves the reasoning_effort the model picker selects', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'xhigh',
    })))
    expect(body['reasoning_effort']).toBe('xhigh')
    expect(body['stream']).toBe(true)
  })

  it('rewrites developer messages to system (upstream rejects developer)', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'developer', content: 'system prompt' },
        { role: 'user', content: 'hi' },
      ],
      reasoning_effort: 'max',
    })))
    const roles = body['messages'].map((message: { role: string }) => message.role)
    expect(roles).toEqual(['system', 'user'])
    expect(body['reasoning_effort']).toBe('max')
  })
})

describe('classifyUpstreamError', () => {
  it('classifies 402 as hard credit', () => {
    expect(classifyUpstreamError(402, '')).toBe('hard_credit')
  })

  it('classifies credit wording in a 200-shaped business error', () => {
    expect(classifyUpstreamError(200, 'code=1 msg=积分不足，请充值')).toBe('hard_credit')
  })

  it('classifies the offline session marker as session dead', () => {
    expect(classifyUpstreamError(401, 'Offline user session not found')).toBe('session_dead')
  })

  it('classifies 429 as soft rate', () => {
    expect(classifyUpstreamError(429, 'slow down')).toBe('soft_rate')
  })

  it('classifies 404 as transient not-found', () => {
    expect(classifyUpstreamError(404, '')).toBe('not_found')
  })

  it('classifies 5xx as server and other 4xx as client', () => {
    expect(classifyUpstreamError(503, '')).toBe('server')
    expect(classifyUpstreamError(400, 'bad')).toBe('client')
  })
})

describe('regionOf', () => {
  it('treats workbuddy.ai domains as global and everything else as cn', () => {
    expect(regionOf('www.codebuddy.cn')).toBe('cn')
    expect(regionOf('workbuddy.ai')).toBe('global')
    expect(regionOf('US.WorkBuddy.AI')).toBe('global')
    expect(regionOf('')).toBe('cn')
  })
})

describe('prepareInternationalChatBody effort handling (issue #49)', () => {
  it('drops the adapter\'s own `off` spelling on the international wire', () => {
    // pi-ai sends `model.thinkingLevelMap.off` for every request that carries
    // no explicit level; the international endpoint rejects it on the GPT
    // family with 400 / 11133 / `extError.param === 'reasoning.effort'`.
    // Omission is the only form measured good on every such model — including
    // `gpt-6-astra`, which also rejects a literal `'none'`.
    const body = JSON.parse(prepareInternationalChatBody(JSON.stringify({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'system', content: 'You are a helpful assistant.' }],
      reasoning_effort: 'off',
    })))
    expect('reasoning_effort' in body).toBe(false)
  })

  it('keeps declared spellings and an explicit `none` untouched', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'none']) {
      const body = JSON.parse(prepareInternationalChatBody(JSON.stringify({
        messages: [{ role: 'system', content: 'You are a helpful assistant.' }],
        reasoning_effort: effort,
      })))
      expect(body['reasoning_effort']).toBe(effort)
    }
  })

  it('strips `off` on every early-return path, not only the system-prompt one', () => {
    // A body without a messages array takes an early return; the strip must
    // still apply, or such a request would reach the international endpoint
    // carrying the rejected spelling.
    const body = JSON.parse(prepareInternationalChatBody(JSON.stringify({ reasoning_effort: 'off' })))
    expect('reasoning_effort' in body).toBe(false)
  })
})

describe('prepareCnChatBody effort handling (issue #87)', () => {
  it('drops the adapter\'s own `off` spelling on the CN wire too', () => {
    // CN used to pass `off` through by an explicit scope decision ("this
    // endpoint has accepted the spelling in every measurement so far"). #87
    // measured it rejecting the spelling on `deepseek-v4.1-flash` — HTTP 400 /
    // 11150 「模型不支持该思考强度」 — so the premise no longer holds and the
    // strip is applied here as well.
    const body = JSON.parse(prepareCnChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'off',
    })))
    expect('reasoning_effort' in body).toBe(false)
    // Everything else about the CN body is untouched.
    expect(body['model']).toBe('deepseek-v4.1-flash')
  })

  it('covers Default as well as Off, since both produce the same body', () => {
    // The picker's Default and its Off entry serialize identically: pi-ai fills
    // `thinkingLevelMap.off` whenever no level is given. A fix that only hid
    // the Off menu item would therefore leave Default failing; the request-layer
    // strip is what makes both succeed.
    const explicitOff = prepareCnChatBody(JSON.stringify({ messages: [], reasoning_effort: 'off' }))
    const noLevel = prepareCnChatBody(JSON.stringify({ messages: [] }))
    expect(JSON.parse(explicitOff)).toEqual(JSON.parse(noLevel))
  })

  it('keeps declared spellings and an explicit `none` untouched on CN', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'none']) {
      const body = JSON.parse(prepareCnChatBody(JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: effort,
      })))
      expect(body['reasoning_effort']).toBe(effort)
    }
  })

  it('does not re-run the shared normalisation over an already-prepared body', () => {
    // The shim applies `prepareChatBody` before handing the body to chatStream,
    // so this step must only strip — re-normalising would be a second pass over
    // an already-normalised body.
    const prepared = prepareChatBody(JSON.stringify({
      messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'hi' }],
      reasoning_effort: 'off',
    }))
    const source = JSON.parse(prepared)
    expect(source['stream']).toBe(true)
    const out = JSON.parse(prepareCnChatBody(prepared))
    // Still normalised exactly once, and no longer carrying the spelling.
    expect(out['stream']).toBe(true)
    expect(out['messages'][0].role).toBe('system')
    expect('reasoning_effort' in out).toBe(false)
  })

  it('returns a non-JSON body unchanged, as the shared preparer does', () => {
    expect(prepareCnChatBody('not json')).toBe('not json')
  })

  it('leaves a JSON array body unchanged rather than re-wrapping it', () => {
    expect(prepareCnChatBody('[1,2]')).toBe('[1,2]')
  })
})

describe('both region paths never send the `off` spelling (issue #87)', () => {
  const REGIONS = [
    ['CN', prepareCnChatBody],
    ['international', prepareInternationalChatBody],
  ] as const

  it.each(REGIONS)('%s drops `off` from the body', (_label, prepare) => {
    const body = JSON.parse(prepare(JSON.stringify({
      model: 'm',
      messages: [{ role: 'system', content: 'sys' }],
      reasoning_effort: 'off',
    })))
    expect('reasoning_effort' in body).toBe(false)
  })

  it.each(REGIONS)('%s omits the field when Default resolves to `off`', (_label, prepare) => {
    // Default and Off serialize identically: pi-ai fills
    // `thinkingLevelMap.off` whenever no level is given. The request layer is
    // what makes both succeed — hiding the Off menu item alone would leave
    // Default failing.
    const explicitOff = prepare(JSON.stringify({ model: 'm', messages: [], reasoning_effort: 'off' }))
    const noLevel = prepare(JSON.stringify({ model: 'm', messages: [] }))
    expect(JSON.parse(explicitOff)).toEqual(JSON.parse(noLevel))
  })

  it.each(REGIONS)('%s leaves every declared spelling and `none` untouched', (_label, prepare) => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'none']) {
      const body = JSON.parse(prepare(JSON.stringify({ messages: [], reasoning_effort: effort })))
      expect(body['reasoning_effort']).toBe(effort)
    }
  })

  it.each(REGIONS)('%s keeps the rest of the body intact', (_label, prepare) => {
    const body = JSON.parse(prepare(JSON.stringify({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 128,
      reasoning_effort: 'off',
    })))
    expect(body['model']).toBe('m')
    expect(body['max_tokens']).toBe(128)
    // Only the strip is shared: the international path still prepends its
    // system prompt (its own documented behaviour), so assert on the caller's
    // message surviving rather than on an identical array.
    const messages = body['messages'] as { role: string, content: string }[]
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'hi' })
    expect(messages.length === 1 || messages[0]?.role === 'system').toBe(true)
  })
})
