// Bound work before copying, cleaning or serializing log data. Never measure the
// original payload with JSON.stringify: image-heavy requests can be tens of MB.
const MAX_LOG_CHARS = 50000
const MAX_STRING_CHARS = 2000
const MAX_STRING_SCAN_CHARS = 10000
const MAX_TOTAL_STRING_CHARS = 16000
const MAX_DEPTH = 8
const MAX_NODES = 1000
const MAX_ENTRIES = 50
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const SKIP_CONSTRUCTORS = new Set([
  'Socket',
  'TLSSocket',
  'HTTPParser',
  'IncomingMessage',
  'ServerResponse'
])

const sanitizeLogData = (input) => {
  const seen = new WeakSet()
  let nodes = 0
  let remainingChars = MAX_TOTAL_STRING_CHARS

  const cleanString = (value, maxChars = MAX_STRING_CHARS) => {
    // Omitting very large strings also avoids flattening a large V8 rope just
    // to extract a short preview.
    if (value.length > MAX_STRING_SCAN_CHARS) {
      const omitted = `[String omitted: ${value.length} chars]`
      remainingChars -= omitted.length
      return omitted
    }

    const length = Math.min(value.length, maxChars, Math.max(0, remainingChars))
    // JSON.stringify handles surrogate pairs and escapes lone surrogates.
    const cleaned = value.slice(0, length).replace(CONTROL_CHAR_PATTERN, '')
    const result =
      length < value.length ? `${cleaned}...[truncated ${value.length - length} chars]` : cleaned
    remainingChars -= result.length
    return result
  }

  const visit = (value, depth = 0, key = '', parent = null) => {
    if (nodes >= MAX_NODES || remainingChars <= 0) {
      return '[Log size limit reached]'
    }
    nodes++

    if (depth > MAX_DEPTH) {
      return '[Max Depth Reached]'
    }

    if (typeof value === 'string') {
      const isBinaryData =
        key === 'data' &&
        parent &&
        (parent.type === 'base64' || parent.mimeType || parent.mime_type || parent.media_type)
      if (isBinaryData) {
        return `[Binary data omitted: ${value.length} chars]`
      }
      if (value.length <= MAX_STRING_SCAN_CHARS && value.startsWith('data:')) {
        return `[Inline data omitted: ${value.length} chars]`
      }
      return cleanString(value)
    }

    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
      return `[${typeof value}]`
    }

    if (value === null || typeof value !== 'object') {
      return value
    }
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
      return `[Binary data omitted: ${value.byteLength} bytes]`
    }
    if (seen.has(value)) {
      return '[Circular Reference]'
    }
    seen.add(value)

    const constructorName = value.constructor?.name
    if (SKIP_CONSTRUCTORS.has(constructorName)) {
      return `[${constructorName} Object]`
    }

    if (Array.isArray(value)) {
      const result = []
      let index = 0
      for (; index < Math.min(value.length, MAX_ENTRIES); index++) {
        if (nodes >= MAX_NODES || remainingChars <= 0) {
          break
        }
        result.push(visit(value[index], depth + 1))
      }
      if (index < value.length) {
        result.push(`[${value.length - index} items omitted]`)
      }
      return result
    }

    const result = Object.create(null)
    let entries = 0
    // Avoid Object.entries(), which reads every value before a limit can apply.
    for (const field in value) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) {
        continue
      }
      if (entries >= MAX_ENTRIES || nodes >= MAX_NODES || remainingChars <= 0) {
        result._truncated = true
        break
      }
      const safeKey = cleanString(field, 128)
      result[safeKey] = visit(value[field], depth + 1, field, value)
      entries++
    }
    return result
  }

  try {
    return visit(input)
  } catch (error) {
    return { error: 'Failed to serialize log data' }
  }
}

const safeStringify = (input) => {
  const result = JSON.stringify(sanitizeLogData(input)) || 'null'
  // Escaping can expand the already bounded data. Keep the final entry valid
  // JSON without serializing or inspecting the original payload again.
  if (result.length > MAX_LOG_CHARS) {
    return JSON.stringify({ _truncated: true, preview: result.slice(0, 8000) })
  }
  return result
}

module.exports = { safeStringify, sanitizeLogData, MAX_LOG_CHARS }
