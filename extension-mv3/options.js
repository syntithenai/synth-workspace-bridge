/** Options page: host permission, one-time pairing token, revoke. */

const ORIGINS = ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']

const extensionId = document.getElementById('extension-id')
const tokenEl = document.getElementById('token')
const saved = document.getElementById('saved')
const grantStatus = document.getElementById('grant-status')

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

void refresh()
