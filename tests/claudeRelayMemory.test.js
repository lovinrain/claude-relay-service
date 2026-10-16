const { EventEmitter } = require('events')
const { Readable } = require('stream')

jest.mock('https', () => ({ request: jest.fn() }))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))
jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 1000,
    claude: { apiVersion: '2023-06-01', overloadHandling: { enabled: 0 } }
  }),
  { virtual: true }
)
jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({
  getAccount: jest.fn(async () => ({
    id: 'account-1',
    extInfo: '{"account_uuid":"real-account"}'
  })),
  getValidAccessToken: jest.fn(async () => 'test-token'),
  clearInternalErrors: jest.fn(async () => {}),
  isAccountOverloaded: jest.fn(async () => false)
}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  selectAccountForApiKey: jest.fn(async () => ({
    accountId: 'account-1',
    accountType: 'claude-official'
  })),
  isAccountRateLimited: jest.fn(async () => false),
  clearSessionMapping: jest.fn(async () => {})
}))
jest.mock('../src/utils/sessionHelper', () => ({ generateSessionHash: () => 'session-hash' }))
jest.mock('../src/services/claudeCodeHeadersService', () => ({
  getAccountHeaders: jest.fn(async () => ({})),
  storeAccountHeaders: jest.fn(async () => {})
}))
jest.mock('../src/models/redis', () => ({ client: { del: jest.fn(async () => {}) } }))
jest.mock('../src/services/userMessageQueueService', () => ({ isUserMessageRequest: () => false }))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(async () => {})
}))
jest.mock('../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForStream: () => undefined,
  getHttpsAgentForNonStream: () => undefined,
  getPricingData: () => ({ 'claude-sonnet-4-6': { max_tokens: 4096 } })
}))

const https = require('https')
const relay = require('../src/services/relay/claudeRelayService')
const identity = require('../src/services/requestIdentityService')

function freezeJson(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeJson)
    Object.freeze(value)
  }
  return value
}

function makeBody() {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 100000,
    temperature: 0.4,
    top_p: 0.9,
    system: [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
      {
        type: 'text',
        text: 'keep my instructions λ',
        cache_control: { type: 'ephemeral', ttl: '1h' }
      }
    ],
    metadata: {
      user_id: JSON.stringify({ device_id: 'device', account_uuid: '', session_id: 'session' })
    },
    tools: [{ name: 'read_file', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'tool', name: 'read_file' },
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'λ.txt' } }]
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'keep my message',
            cache_control: { type: 'ephemeral', ttl: '1h' }
          },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }
        ]
      }
    ]
  }
}

function makeResponseStream() {
  const response = new EventEmitter()
  response.headersSent = false
  response.writableEnded = false
  response.chunks = []
  response.getHeader = () => undefined
  response.writeHead = jest.fn(() => {
    response.headersSent = true
  })
  response.write = jest.fn((chunk) => {
    response.headersSent = true
    response.chunks.push(String(chunk))
    return true
  })
  response.end = jest.fn(() => {
    response.writableEnded = true
  })
  return response
}

function successfulResponse(body, stream) {
  const tool = { type: 'tool_use', id: 'output-tool', name: body.tools[0].name, input: {} }
  return {
    statusCode: 200,
    body: stream
      ? [
          { type: 'message_start', message: { model: body.model, usage: { input_tokens: 3 } } },
          { type: 'content_block_start', index: 0, content_block: tool },
          { type: 'message_delta', usage: { output_tokens: 2 } }
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join('')
      : JSON.stringify({ content: [tool], usage: { input_tokens: 3, output_tokens: 2 } })
  }
}

describe('Claude request bodies and retries', () => {
  let responses
  let uploads

  beforeEach(() => {
    jest.clearAllMocks()
    responses = []
    uploads = []
    jest.spyOn(relay, '_sleep').mockResolvedValue(undefined)
    https.request.mockImplementation((options, callback) => {
      const request = new EventEmitter()
      request.destroyed = false
      request.destroy = jest.fn((error) => {
        request.destroyed = true
        if (error) {
          setImmediate(() => request.emit('error', error))
        }
      })
      request.end = jest.fn((bytes) => {
        expect(Buffer.isBuffer(bytes)).toBe(true)
        expect(options.headers['content-length']).toBe(String(bytes.length))
        const body = JSON.parse(bytes.toString('utf8'))
        uploads.push(body)
        const next = responses.shift()
        setImmediate(() => {
          if (next instanceof Error) {
            request.emit('error', next)
            return
          }
          const result = typeof next === 'function' ? next(body) : next
          const upstream = Readable.from([Buffer.from(result.body)])
          upstream.statusCode = result.statusCode
          upstream.headers = {}
          callback(upstream)
        })
        return request
      })
      return request
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('keeps the incoming body unchanged while applying existing request normalization', () => {
    const original = freezeJson(makeBody())
    const processed = relay._processRequestBody(original, null, true)
    expect(processed.max_tokens).toBe(4096)
    expect(processed).not.toHaveProperty('top_p')
    expect(processed.messages[1].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tool-1',
      is_error: true
    })
    expect(
      processed.messages[1].content.find((block) => block.type === 'text').cache_control
    ).toEqual({
      type: 'ephemeral'
    })
    expect(processed.system[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(original).toEqual(makeBody())
  })

  it('isolates nested identity transforms from the retry template', async () => {
    const template = freezeJson(makeBody())
    jest.spyOn(identity, 'transform').mockImplementation(({ body, headers }) => {
      body.tools[0].input_schema.properties.extra = { type: 'string' }
      body.messages[0].content[0].input.path = 'rewritten'
      return { body, headers }
    })
    const prepared = await relay._prepareRequestHeadersAndPayload(
      template,
      {},
      'account-1',
      'token',
      {
        account: {},
        requestOptions: { isRealClaudeCodeRequest: true }
      }
    )
    const sent = JSON.parse(prepared.bodyBuffer.toString())
    expect(sent.messages[0].content[0].input.path).toBe('rewritten')
    expect(sent.tools[0].input_schema.properties.extra).toEqual({ type: 'string' })
    expect(template).toEqual(makeBody())
  })

  it('preserves official-client tool names and Unicode bytes', async () => {
    const body = freezeJson(makeBody())
    const result = await relay._prepareRequestHeadersAndPayload(body, {}, 'account-1', 'token', {
      account: {},
      requestOptions: { isRealClaudeCodeRequest: true }
    })
    const sent = JSON.parse(result.bodyBuffer.toString('utf8'))
    expect(sent.tools[0].name).toBe('read_file')
    expect(sent.messages[0].content[0].input.path).toBe('λ.txt')
    expect(result.toolNameMap).toBeNull()
    expect(result.headers['content-length']).toBe(String(result.bodyBuffer.length))
    expect(result.headers['accept-encoding']).toBe('identity')
  })

  it.each([false, true])(
    'retries 403 without reapplying transforms to mutated names (stream=%p)',
    async (stream) => {
      const original = freezeJson({ ...makeBody(), stream })
      responses.push(
        { statusCode: 403, body: '{"error":{"message":"temporarily forbidden"}}' },
        (body) => successfulResponse(body, stream)
      )
      const responseStream = makeResponseStream()
      const usage = jest.fn()
      let result
      if (stream) {
        await relay.relayStreamRequestWithUsageCapture(
          original,
          { name: 'test' },
          responseStream,
          {},
          usage
        )
        expect(responseStream.chunks.join('')).toContain('"name":"read_file"')
        expect(usage).toHaveBeenCalledWith(
          expect.objectContaining({ input_tokens: 3, output_tokens: 2 })
        )
      } else {
        result = await relay.relayRequest(original, { name: 'test' }, null, null, {})
        expect(JSON.parse(result.body).content[0].name).toBe('read_file')
      }
      expect(uploads).toHaveLength(2)
      expect(uploads[0].tools[0].name).toBe('ReadFile_tool')
      expect(uploads[1]).toEqual(uploads[0])
      expect(original).toEqual({ ...makeBody(), stream })
    }
  )

  it.each([false, true])(
    'retries credential errors using the original tool names (stream=%p)',
    async (stream) => {
      const original = freezeJson({ ...makeBody(), stream })
      responses.push(
        {
          statusCode: 400,
          body: '{"error":{"message":"only authorized for use with claude code"}}'
        },
        (body) => successfulResponse(body, stream)
      )
      jest.spyOn(relay, '_getToolNameSuffix').mockReturnValue('fixed')
      const responseStream = makeResponseStream()
      if (stream) {
        await relay.relayStreamRequestWithUsageCapture(
          original,
          { name: 'test' },
          responseStream,
          {},
          null
        )
        expect(responseStream.chunks.join('')).toContain('"name":"read_file"')
      } else {
        const result = await relay.relayRequest(original, { name: 'test' }, null, null, {})
        expect(JSON.parse(result.body).content[0].name).toBe('read_file')
      }
      expect(uploads).toHaveLength(2)
      expect(uploads[0].tools[0].name).toBe('ReadFile_tool')
      expect(uploads[1].tools[0].name).toBe('read_file_fixed')
      expect(uploads[1].tool_choice.name).toBe('read_file_fixed')
      const toolUse = uploads[1].messages
        .flatMap((message) => message.content)
        .find((block) => block.type === 'tool_use')
      expect(toolUse.name).toBe('read_file_fixed')
      expect(uploads[1].metadata).toEqual(uploads[0].metadata)
      expect(original).toEqual({ ...makeBody(), stream })
    }
  )

  it.each([false, true])(
    'propagates upstream failures without changing the incoming body (stream=%p)',
    async (stream) => {
      const original = freezeJson({ ...makeBody(), stream })
      responses.push(new Error('test transport failure'))
      const operation = stream
        ? relay.relayStreamRequestWithUsageCapture(
            original,
            { name: 'test' },
            makeResponseStream(),
            {},
            null
          )
        : relay.relayRequest(original, { name: 'test' }, null, null, {})
      await expect(operation).rejects.toThrow(
        stream ? 'test transport failure' : 'Upstream request failed'
      )
      expect(original).toEqual({ ...makeBody(), stream })
    }
  )
})
