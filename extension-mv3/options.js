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

extensionId.textContent = chrome.runtime.id

async function refresh() {
  const { pairingToken } = await chrome.storage.local.get('pairingToken')
  tokenEl.textContent = pairingToken || '— none —'
  const granted = await chrome.permissions.contains({ origins: ORIGINS })
  grantStatus.textContent = granted ? 'Granted' : 'Not granted yet'
}

document.getElementById('grant').addEventListener('click', async () => {
  const granted = await chrome.permissions.request({ origins: ORIGINS })
  grantStatus.textContent = granted ? 'Granted' : 'Not granted'
})

document.getElementById('generate').addEventListener('click', async () => {
  const pairingToken = crypto.randomUUID() + crypto.randomUUID()
  await chrome.storage.local.set({ pairingToken })
  saved.textContent = 'New token saved. Any page paired with the old one is disconnected.'
  await refresh()
})

document.getElementById('revoke').addEventListener('click', async () => {
  await chrome.storage.local.remove('pairingToken')
  saved.textContent = 'Pairing revoked. Regenerate to pair again.'
  await refresh()
})

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
