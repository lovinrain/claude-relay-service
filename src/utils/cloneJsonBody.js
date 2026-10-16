// Request bodies contain JSON values. Copy their mutable containers without
// duplicating immutable strings, which can include many megabytes of base64.
function cloneJsonBody(value) {
  if (value === null || typeof value !== 'object') {
    return value
  }

  const cloned = Array.isArray(value) ? value.slice() : { ...value }
  const pending = [cloned]

  while (pending.length > 0) {
    const current = pending.pop()
    for (const key of Object.keys(current)) {
      const child = current[key]
      if (child !== null && typeof child === 'object') {
        const copiedChild = Array.isArray(child) ? child.slice() : { ...child }
        current[key] = copiedChild
        pending.push(copiedChild)
      }
    }
  }

  return cloned
}

module.exports = cloneJsonBody
