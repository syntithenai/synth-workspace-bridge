/** Options page: browser-control test, host permission, pairing token, revoke. */

// The manifest is the single list of provider origins. Keeping the request in
// step with it means a new provider cannot be added in one place and forgotten
// in the other.
const ORIGINS = chrome.runtime.getManifest().optional_host_permissions || []

const extensionId = document.getElementById('extension-id')
const tokenEl = document.getElementById('token')
const saved = document.getElementById('saved')
const grantStatus = document.getElementById('grant-status')
const browserStatus = document.getElementById('browser-status')
const testBrowser = document.getElementById('test-browser')
const originsEl = document.getElementById('paired-origins')
const pairRequestEl = document.getElementById('pair-request')
const pairOriginEl = document.getElementById('pair-origin')

extensionId.textContent = chrome.runtime.id

async function readState() {
  const { pairingToken, pairedOrigins } = await chrome.storage.local.get([
    'pairingToken',
    'pairedOrigins',
  ])
  return {
    pairingToken: typeof pairingToken === 'string' ? pairingToken : undefined,
    origins: Array.isArray(pairedOrigins)
      ? pairedOrigins.filter((origin) => typeof origin === 'string')
      : [],
  }
}

async function refresh() {
  const { pairingToken, origins } = await readState()
  tokenEl.textContent = pairingToken || '— none —'

  // Build with textContent: an origin is attacker-influenced text, never HTML.
  originsEl.innerHTML = ''
  if (!origins.length) {
    const empty = document.createElement('li')
    empty.className = 'muted'
    empty.textContent = 'No deployment is approved yet.'
    originsEl.appendChild(empty)
  }
  for (const origin of origins) {
    const item = document.createElement('li')
    const label = document.createElement('span')
    label.textContent = origin
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'secondary'
    remove.textContent = 'Remove'
    remove.addEventListener('click', () => void removeOrigin(origin))
    item.append(label, remove)
    originsEl.appendChild(item)
  }

  const granted = await chrome.permissions.contains({ origins: ORIGINS })
  grantStatus.textContent = granted ? 'Granted' : 'Not granted yet'
}

async function removeOrigin(origin) {
  const { origins } = await readState()
  await chrome.storage.local.set({ pairedOrigins: origins.filter((item) => item !== origin) })
  saved.textContent = `${origin} must pair again.`
  await refresh()
}

async function clearPending() {
  try {
    await chrome.storage.session.remove('pairRequests')
  } catch {
    // Session storage is best effort.
  }
}

document.getElementById('grant').addEventListener('click', async () => {
  const granted = await chrome.permissions.request({ origins: ORIGINS })
  grantStatus.textContent = granted ? 'Granted' : 'Not granted'
})

document.getElementById('generate').addEventListener('click', async () => {
  const pairingToken = crypto.randomUUID() + crypto.randomUUID()
  // Rotating must also drop the approved origins, or they would receive the new
  // token without a fresh approval.
  await chrome.storage.local.set({ pairingToken, pairedOrigins: [] })
  await clearPending()
  saved.textContent = 'Token rotated. Every deployment must pair again.'
  await refresh()
})

document.getElementById('revoke').addEventListener('click', async () => {
  await chrome.storage.local.remove(['pairingToken', 'pairedOrigins'])
  await clearPending()
  saved.textContent = 'Pairing revoked. A deployment has to pair again.'
  await refresh()
})

for (const [buttonId, value] of [
  ['copy-id', () => chrome.runtime.id],
  ['copy-token', async () => (await readState()).pairingToken || ''],
]) {
  document.getElementById(buttonId).addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(await value())
      saved.textContent = 'Copied.'
    } catch {
      saved.textContent = 'Could not copy; select the text manually.'
    }
  })
}

/**
 * Approval card used when Chrome notifications are unavailable: the background
 * worker opened this page with #pair=<requestId>.
 */
const pairRequestId = new URLSearchParams(location.hash.replace(/^#/, '')).get('pair')

async function decide(allow) {
  const result = await chrome.runtime.sendMessage({
    target: 'background',
    type: 'pair.decide',
    requestId: pairRequestId,
    allow,
  })
  pairRequestEl.hidden = true
  saved.textContent =
    result && result.ok && result.status === 'approved'
      ? 'Paired. Return to the workspace.'
      : 'Pairing was not approved.'
  await refresh()
}

if (pairRequestId) {
  void (async () => {
    const request = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'pair.inspect',
      requestId: pairRequestId,
    })
    if (!request || !request.ok) {
      saved.textContent = 'That pairing request has expired.'
      return
    }
    pairOriginEl.textContent = `${request.origin} wants to send model requests and control tabs through this extension.`
    pairRequestEl.hidden = false
  })()
}

document.getElementById('pair-allow').addEventListener('click', () => void decide(true))
document.getElementById('pair-deny').addEventListener('click', () => void decide(false))

function status(text, kind) {
  browserStatus.textContent = text
  browserStatus.className = kind ? `muted ${kind}` : 'muted'
}

/**
 * Proves the extension can attach to a real tab. The test deliberately picks a
 * web tab rather than the options page: Chrome refuses to debug chrome:// and
 * chrome-extension:// pages.
 */
testBrowser.addEventListener('click', async () => {
  testBrowser.disabled = true
  status('Testing…', '')
  let tabId
  try {
    const targets = (await chrome.debugger.getTargets()).filter(
      (candidate) =>
        candidate.type === 'page' &&
        typeof candidate.tabId === 'number' &&
        /^https?:/i.test(candidate.url || ''),
    )
    const active = await chrome.tabs.query({ active: true })
    const activeIds = new Set(active.map((tab) => tab.id))
    const tab = targets.find((candidate) => activeIds.has(candidate.tabId)) || targets[0]
    if (!tab) {
      status('Open an http(s) page in this browser first.', 'error')
      return
    }
    tabId = tab.tabId
    await chrome.debugger.attach({ tabId }, '1.3')
    const result = await chrome.debugger.sendCommand(
      { tabId },
      'Runtime.evaluate',
      { expression: 'document.title', returnByValue: true },
    )
    const title = result && result.result ? result.result.value : ''
    status(
      `Browser control works: ${targets.length} web tab${targets.length === 1 ? '' : 's'} reachable${
        title ? `, active page “${String(title).slice(0, 80)}”` : ''
      }.`,
      'ok',
    )
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    status(
      /already attached/i.test(message)
        ? 'Close DevTools for that tab, then test again.'
        : `Browser control failed: ${message}`,
      'error',
    )
  } finally {
    if (typeof tabId === 'number') {
      await chrome.debugger.detach({ tabId }).catch(() => undefined)
    }
    testBrowser.disabled = false
  }
})

void refresh()
