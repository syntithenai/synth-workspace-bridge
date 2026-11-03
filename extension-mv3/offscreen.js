/**
 * Offscreen document: performs the provider fetch and streams the body back to
 * the service worker one chunk at a time. Nothing is persisted here; the key
 * exists only in the headers of the request for the length of the call.
 */

function emit(event) {
  chrome.runtime.sendMessage({ target: 'background', type: 'proxy-event', event })
}

function base64ToBytes(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function bytesToBase64(bytes) {
  let binary = ''
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + step))
  }
  return btoa(binary)
}

async function run(request) {
  const { id } = request
  try {
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers || {})) {
      headers.set(name, value)
    }
    const response = await fetch(request.url, {
      method: request.method,
      headers,
      body: request.body ? base64ToBytes(request.body) : undefined,
      credentials: 'omit',
      redirect: 'follow',
    })
    const responseHeaders = {}
    for (const [name, value] of response.headers) responseHeaders[name] = value
    emit({
      type: 'response',
      id,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
    if (!response.body) {
      emit({ type: 'end', id })
      return
    }
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        emit({ type: 'chunk', id, data: bytesToBase64(value) })
      }
    }
    emit({ type: 'end', id })
  } catch (error) {
    emit({
      type: 'error',
      id,
      code: 'network',
      message: String(error && error.message ? error.message : error),
    })
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== 'offscreen' || message.type !== 'proxy-request') return
  void run(message.request)
})
