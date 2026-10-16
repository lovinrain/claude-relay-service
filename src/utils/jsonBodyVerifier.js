function isBlankBody(buffer, encoding) {
  if (encoding === 'utf8' || encoding === 'utf-8') {
    // Valid UTF-8 JSON starts with ASCII after any whitespace. Most requests
    // return on the opening brace, without decoding their large payloads.
    for (const byte of buffer) {
      if (byte === 0x20 || (byte >= 0x09 && byte <= 0x0d)) {
        continue
      }
      if (byte < 0x80) {
        return false
      }
      // Preserve String.trim's treatment of BOMs and Unicode whitespace.
      return !buffer.toString(encoding).trim()
    }
    return true
  }

  return !buffer.toString(encoding).trim()
}

function verifyJsonBody(_req, _res, buffer, encoding) {
  if (buffer && buffer.length && isBlankBody(buffer, encoding || 'utf8')) {
    throw new Error('Invalid JSON: empty body')
  }
}

module.exports = verifyJsonBody
