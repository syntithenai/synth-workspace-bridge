/**
 * Tells the workspace page which extension is installed.
 *
 * Runs only on the workspace origins declared in manifest.json's
 * `content_scripts.matches` (suite.synthfit.online, localhost, 127.0.0.1). It
 * reads no page data: the whole message is this install's id and version.
 *
 * The announcement is a hint, not a trust decision. The page still has to send
 * a `pair.request`, and the background worker only hands over the pairing token
 * after the user approves it in a Chrome notification.
 *
 * Timing is not guaranteed: at `document_start` the element may not exist yet,
 * the page may mount its listener later, and bfcache restores skip script
 * execution. So the script re-announces on DOMContentLoaded/pageshow and when
 * the page says hello.
 */
;(() => {
  const SOURCE = 'synth-workspace-bridge'
  const PAGE_SOURCE = 'synth-workspace-page'
  const DATASET_KEY = 'synthBridge'

  const extensionId = chrome.runtime.id
  const version = chrome.runtime.getManifest().version

  function announce() {
    try {
      if (document.documentElement) {
        document.documentElement.dataset[DATASET_KEY] = `${extensionId}|${version}`
      }
    } catch {
      // The element is not available yet; postMessage below still runs.
    }
    // Target this origin explicitly rather than '*': a cross-origin frame must
    // not be able to read the announcement.
    window.postMessage(
      { source: SOURCE, type: 'announce', extensionId, version },
      window.location.origin,
    )
  }

  window.addEventListener('message', (event) => {
    const data = event.data
    if (
      event.source !== window ||
      event.origin !== window.location.origin ||
      !data ||
      data.source !== PAGE_SOURCE ||
      data.type !== 'hello'
    ) {
      return
    }
    announce()
  })

  announce()
  document.addEventListener('DOMContentLoaded', announce)
  window.addEventListener('pageshow', announce)
})()
