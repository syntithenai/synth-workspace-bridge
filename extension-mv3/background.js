/**
 * MV3 service worker: validates paired PWA connections and relays one HTTP
 * request at a time to the offscreen document, which owns the actual fetch and
 * the response stream. The worker itself never stores request data; an MV3
 * worker can be terminated mid-stream, so the stream lives offscreen.
 */

const MODEL_PORT_NAME = 'synth-workspace-model'

/** id -> port, so stream events can find the page that asked. */
const jobs = new Map()

function proxyable(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return true
    if (parsed.protocol !== 'http:') return false
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]'
    )
  } catch {
    return false
  }
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Stream provider responses back to the Synth Workspace page.',
  })
}

function fail(port, id, code, message) {
  port.postMessage({ type: 'error', id, code, message })
}

chrome.runtime.onConnectExternal.addListener((port) => {
  if (port.name !== MODEL_PORT_NAME) return

  port.onMessage.addListener(async (message) => {
    if (!message || message.type !== 'http' || typeof message.id !== 'string') return
    const { pairingToken } = await chrome.storage.local.get('pairingToken')
    if (!pairingToken || message.token !== pairingToken) {
      fail(port, message.id, 'extension_unavailable', 'This page is not paired.')
      return
    }
    if (!proxyable(message.url)) {
      fail(port, message.id, 'blocked_url', 'Only https and localhost URLs are proxied.')
      return
    }
    jobs.set(message.id, port)
    try {
      await ensureOffscreen()
      chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'proxy-request',
        request: {
          id: message.id,
          url: message.url,
          method: message.method || 'POST',
          headers: message.headers || {},
          body: message.body || null,
        },
      })
    } catch (error) {
      jobs.delete(message.id)
      fail(port, message.id, 'extension_unavailable', String(error && error.message ? error.message : error))
    }
  })

  port.onDisconnect.addListener(() => {
    for (const [id, owner] of jobs) if (owner === port) jobs.delete(id)
  })
})

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== 'background' || message.type !== 'proxy-event') return
  const event = message.event
  if (!event || typeof event.id !== 'string') return
  const port = jobs.get(event.id)
  if (!port) return
  try {
    port.postMessage(event)
  } catch {
    // The page went away.
  }
  if (event.type === 'end' || event.type === 'error') jobs.delete(event.id)
})
