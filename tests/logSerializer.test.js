const { safeStringify } = require('../src/utils/logSerializer')

describe('bounded log serialization', () => {
  test('preserves ordinary structured metadata and Unicode without mutating it', () => {
    const metadata = {
      requestId: 'request-1',
      model: 'claude-test',
      status: 200,
      duration: 120,
      details: { text: 'Image review 🖼️', stream: true },
      usage: [12, 34, null]
    }

    expect(JSON.parse(safeStringify(metadata))).toEqual(metadata)
    expect(metadata.details.text).toBe('Image review 🖼️')
  })

  test('omits a 25 MB base64 image, inline data URLs and binary buffers', () => {
    const image = 'A'.repeat(25000000)
    const metadata = {
      image: { type: 'base64', media_type: 'image/png', data: image },
      inlineData: { mimeType: 'image/png', data: 'PRIVATE_IMAGE' },
      image_url: 'data:image/png;base64,PRIVATE_IMAGE',
      buffer: Buffer.from('PRIVATE_IMAGE')
    }

    const output = safeStringify(metadata)
    expect(output.length).toBeLessThan(1000)
    expect(output).not.toContain('PRIVATE_IMAGE')
    expect(output).toContain('25000000 chars')
    expect(JSON.parse(output).image.media_type).toBe('image/png')
    expect(metadata.image.data).toBe(image)
  })

  test('omits huge strings even when they are not recognized as image data', () => {
    const output = safeStringify({ requestId: 'request-2', unexpected: 'X'.repeat(25000000) })

    expect(JSON.parse(output)).toEqual({
      requestId: 'request-2',
      unexpected: '[String omitted: 25000000 chars]'
    })
  })

  test('does not eagerly read an entire large array or object', () => {
    const array = new Array(1000000).fill(null)
    const unexpectedRead = jest.fn(() => {
      throw new Error('Read outside the log preview')
    })
    Object.defineProperty(array, 100000, { get: unexpectedRead })
    const object = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`field${i}`, i]))
    Object.defineProperty(object, 'unvisited', { enumerable: true, get: unexpectedRead })

    const output = safeStringify({ array, object })
    expect(unexpectedRead).not.toHaveBeenCalled()
    expect(output.length).toBeLessThan(5000)
    expect(output).toContain('omitted')
    expect(output).toContain('_truncated')
    expect(JSON.parse(output)).not.toHaveProperty('error')
  })

  test('limits cumulative traversal across many individually small objects', () => {
    let reads = 0
    const groups = Array.from({ length: 40 }, () =>
      Array.from({ length: 40 }, () => ({
        get text() {
          reads++
          return 'entry'
        }
      }))
    )

    const output = safeStringify(groups)
    expect(reads).toBeLessThan(1000)
    expect(reads).toBeGreaterThan(0)
    expect(output.length).toBeLessThanOrEqual(50000)
    expect(() => JSON.parse(output)).not.toThrow()
  })

  test('handles cycles and deep objects without recursing through the full input', () => {
    const cycle = { name: 'cycle' }
    cycle.self = cycle
    let deep = { end: true }
    for (let i = 0; i < 10000; i++) {
      deep = { next: deep }
    }

    const output = safeStringify({ cycle, deep })
    expect(output).toContain('[Circular Reference]')
    expect(output).toContain('[Max Depth Reached]')
    expect(output.length).toBeLessThan(1000)
  })

  test('keeps escape-heavy output bounded and valid JSON', () => {
    const input = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`field${i}`, '\ud800'.repeat(2000)])
    )

    const output = safeStringify(input)
    expect(output.length).toBeLessThanOrEqual(50000)
    expect(() => JSON.parse(output)).not.toThrow()
  })

  test('does not invoke toJSON on the original object', () => {
    const toJSON = jest.fn(() => {
      throw new Error('Original object must not be serialized')
    })

    expect(JSON.parse(safeStringify({ nested: { text: 'safe', toJSON } })).nested.text).toBe('safe')
    expect(toJSON).not.toHaveBeenCalled()
  })
})
