const { EventEmitter } = require('events')

jest.mock('../config/config', () => ({}), { virtual: true })
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/services/userService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/services/claudeRelayConfigService', () => ({}))
jest.mock('../src/validators/clientValidator', () => ({}))
jest.mock('../src/validators/clients/claudeCodeValidator', () => ({}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const logger = require('../src/utils/logger')
const { requestLogger } = require('../src/middleware/auth')

function createRequestResponse(status = 200, url = '/api/v1/messages') {
  const requestHeaders = { 'Content-Length': '25386713', 'User-Agent': 'test-client' }
  const req = {
    method: 'POST',
    originalUrl: url,
    ip: '127.0.0.1',
    get: (name) => requestHeaders[name],
    apiKey: { id: 'key-1', name: 'test-key' },
    _authInfo: 'test-user'
  }
  const res = new EventEmitter()
  res.statusCode = status
  res.setHeader = jest.fn()
  res.get = (name) => (name === 'Content-Length' ? '100' : undefined)
  res.json = jest.fn(() => res)
  return { req, res }
}

beforeEach(() => jest.clearAllMocks())

test.each([
  [200, 'info'],
  [400, 'warn'],
  [500, 'error']
])('logs metadata without request or response bodies for HTTP %i', (status, level) => {
  const { req, res } = createRequestResponse(status)
  const next = jest.fn()
  const originalJson = res.json
  requestLogger(req, res, next)

  // The real application installs the logger before its JSON parser.
  const toJSON = jest.fn(() => {
    throw new Error('Conversation/image body must not be serialized')
  })
  req.body = {
    model: 'claude-test',
    stream: true,
    messages: [{ role: 'user', content: [{ type: 'image', data: 'A'.repeat(25000000) }] }],
    toJSON
  }
  const responseBody = { content: 'PRIVATE_RESPONSE', toJSON }
  expect(res.json(responseBody)).toBe(res)
  res.emit('finish')

  expect(next).toHaveBeenCalledTimes(1)
  expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', req.requestId)
  expect(res.json).toBe(originalJson)
  expect(res).not.toHaveProperty('_responseBody')
  expect(logger[level]).toHaveBeenCalledWith(
    expect.stringContaining(`${status} POST /api/v1/messages`),
    expect.objectContaining({
      requestId: req.requestId,
      requestBytes: '25386713',
      model: 'claude-test',
      messageCount: 1,
      stream: true,
      key: 'test-key (key-1)',
      auth: 'test-user'
    })
  )
  const calls = [...logger.debug.mock.calls, ...logger[level].mock.calls]
  expect(() => JSON.stringify(calls)).not.toThrow()
  expect(JSON.stringify(calls).length).toBeLessThan(2000)
  expect(JSON.stringify(calls)).not.toContain('PRIVATE_RESPONSE')
  expect(toJSON).not.toHaveBeenCalled()
  expect(req.body.messages[0].content[0].data.length).toBe(25000000)
})

test('does not pass an already parsed body to the request-start debug logger', () => {
  const { req, res } = createRequestResponse()
  req.body = { messages: [{ content: 'PRIVATE_PROMPT' }] }
  requestLogger(req, res, jest.fn())
  res.emit('finish')

  expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('PRIVATE_PROMPT')
  expect(JSON.stringify(logger.info.mock.calls)).not.toContain('PRIVATE_PROMPT')
})

test('handles requests without a body or Content-Length', () => {
  const { req, res } = createRequestResponse()
  req.get = () => undefined
  requestLogger(req, res, jest.fn())
  expect(() => res.emit('finish')).not.toThrow()
  expect(logger.info.mock.calls[0][1]).not.toHaveProperty('requestBytes')
  expect(logger.info.mock.calls[0][1]).not.toHaveProperty('model')
})

test('continues to suppress health-check logs', () => {
  const { req, res } = createRequestResponse(200, '/health')
  requestLogger(req, res, jest.fn())
  res.emit('finish')

  expect(logger.debug).not.toHaveBeenCalled()
  expect(logger.info).not.toHaveBeenCalled()
})
