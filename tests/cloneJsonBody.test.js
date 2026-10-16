const cloneJsonBody = require('../src/utils/cloneJsonBody')

describe('cloneJsonBody', () => {
  it('preserves JSON data and isolates mutations at every container level', () => {
    const source = JSON.parse(
      '{"messages":[{"content":[{"text":"hello λ","source":{"data":"QUJD"}}]}],"flags":[null,true,0,""]}'
    )
    const copied = cloneJsonBody(source)

    expect(copied).toEqual(source)
    copied.messages[0].content[0].source.data = 'changed'
    copied.messages[0].content.push({ text: 'new' })
    copied.flags.pop()

    expect(source.messages[0].content).toEqual([{ text: 'hello λ', source: { data: 'QUJD' } }])
    expect(source.flags).toEqual([null, true, 0, ''])
  })

  it('preserves JSON keys named __proto__ without changing object prototypes', () => {
    const source = JSON.parse('{"__proto__":{"nested":[1]},"constructor":{"value":2}}')
    const copied = cloneJsonBody(source)

    expect(JSON.stringify(copied)).toBe(JSON.stringify(source))
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype)
    copied.__proto__.nested.push(3)
    expect(source.__proto__.nested).toEqual([1])
  })

  it.each([null, true, 0, '', 'hello λ'])('preserves the primitive %p', (value) => {
    expect(cloneJsonBody(value)).toBe(value)
  })
})
