const mockEntries = []

// Keep the real Winston pipeline, but capture every transport in memory.
jest.mock('winston', () => {
  const winston = jest.requireActual('winston')
  class MemoryTransport extends winston.Transport {
    log(info, callback) {
      mockEntries.push(info[Symbol.for('message')])
      callback()
    }
  }
  return {
    ...winston,
    transports: { ...winston.transports, Console: MemoryTransport, File: MemoryTransport }
  }
})
jest.mock('winston-daily-rotate-file', () => require('winston').transports.File)
jest.mock(
  '../config/config',
  () => ({
    logging: { dirname: require('os').tmpdir(), level: 'info', maxSize: '10m', maxFiles: 2 },
    system: { timezoneOffset: 8 }
  }),
  { virtual: true }
)

const logger = require('../src/utils/logger')

beforeEach(() => {
  logger.level = 'info'
  mockEntries.length = 0
})
afterAll(() => logger.close())

test('bounds image-heavy metadata in both file and console formats', () => {
  logger.info('image-heavy request', {
    requestId: 'request-1',
    nested: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(25000000) },
    unexpectedString: 'X'.repeat(25000000)
  })

  expect(mockEntries).toHaveLength(2)
  for (const entry of mockEntries) {
    expect(entry).toContain('request-1')
    expect(entry).toContain('omitted')
    expect(entry.length).toBeLessThan(2000)
  }
})

test('bounds top-level strings as well as nested objects in console output', () => {
  logger.error('X'.repeat(25000000), { detail: 'Y'.repeat(25000000) })

  expect(mockEntries).toHaveLength(3)
  for (const entry of mockEntries) {
    expect(entry.length).toBeLessThan(2000)
    expect(entry).toContain('25000000 chars')
  }
})

test('skips disabled levels before formatting nested metadata', () => {
  const read = jest.fn(() => 'must not be read')
  const nested = Object.defineProperty({}, 'expensive', { enumerable: true, get: read })
  logger.debug('disabled debug log', { nested })
  logger.level = 'warn'
  logger.info('disabled info log', { nested })

  expect(read).not.toHaveBeenCalled()
  expect(mockEntries).toHaveLength(0)
})

test('retains error messages and stack traces', () => {
  logger.error(new Error('Test failure'))

  expect(mockEntries).toHaveLength(3)
  for (const entry of mockEntries) {
    expect(entry).toContain('Test failure')
    expect(entry).toContain('logger.test.js')
  }
})
