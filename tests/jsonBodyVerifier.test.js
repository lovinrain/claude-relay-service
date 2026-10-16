const express = require('express')
const request = require('supertest')
const verifyJsonBody = require('../src/utils/jsonBodyVerifier')

describe('JSON body verification', () => {
  it('does not decode an ordinary UTF-8 JSON payload during verification', () => {
    const buffer = Buffer.from(JSON.stringify({ messages: [{ content: 'hello λ'.repeat(4096) }] }))
    const decode = jest.spyOn(buffer, 'toString')
    verifyJsonBody(null, null, buffer, 'utf-8')
    expect(decode).not.toHaveBeenCalled()
  })

  it.each([' ', '\t\n\r', '\v\f', '\u00a0', '\ufeff', '\u2003\n', '\ufeff\u2003'])(
    'preserves rejection of a whitespace-only body %p',
    (text) => {
      expect(() => verifyJsonBody(null, null, Buffer.from(text), 'utf8')).toThrow(
        'Invalid JSON: empty body'
      )
    }
  )

  it('preserves the existing handling of empty buffers and other encodings', () => {
    expect(() => verifyJsonBody(null, null, Buffer.alloc(0), 'utf8')).not.toThrow()
    expect(() => verifyJsonBody(null, null, Buffer.from(' \t', 'utf16le'), 'utf16le')).toThrow(
      'Invalid JSON: empty body'
    )
    expect(() =>
      verifyJsonBody(null, null, Buffer.from('{"value":"λ"}', 'utf16le'), 'utf16le')
    ).not.toThrow()
  })

  it.each(['', ' ', '\ufeff'])('leaves valid JSON intact with prefix %p', async (prefix) => {
    const app = express()
    app.use(express.json({ verify: verifyJsonBody }))
    app.post('/', (req, res) => res.json(req.body))
    const body = { messages: [{ content: 'hello λ\n' }], metadata: { value: null } }
    const response = await request(app)
      .post('/')
      .set('Content-Type', 'application/json')
      .send(prefix + JSON.stringify(body))
    expect(response.status).toBe(200)
    expect(response.body).toEqual(body)
  })

  it('still rejects blank and malformed JSON through Express', async () => {
    const app = express()
    app.use(express.json({ verify: verifyJsonBody }))
    app.post('/', (_req, res) => res.sendStatus(200))
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ type: error.type }))
    const blank = await request(app).post('/').set('Content-Type', 'application/json').send(' \n')
    expect(blank.status).toBe(403)
    expect(blank.body.type).toBe('entity.verify.failed')
    const malformed = await request(app).post('/').set('Content-Type', 'application/json').send('{')
    expect(malformed.status).toBe(400)
    expect(malformed.body.type).toBe('entity.parse.failed')
  })
})
