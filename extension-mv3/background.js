/**
 * MV3 service worker for the Synth Workspace bridge.
 *
 * Two things happen here:
 *
 * 1. Model egress. The page validates the pairing token, then the request is
 *    relayed to the offscreen document, which owns the fetch and the response
 *    stream. An MV3 worker can be terminated mid-stream, so the stream lives
 *    offscreen. The worker itself never stores request data.
 *
 * 2. Browser control. The page asks the extension to list, read, open, click,
 *    type, screenshot or navigate in the user's own tabs. Actions use the
 *    Chrome DevTools Protocol through `chrome.debugger`, which mirrors the
 *    server browser tools: same element lookup, same password refusal, same
 *    screenshot semantics. The debugger is attached only for the duration of
 *    one action, so no tab stays under control while idle.
 *
 * There is deliberately no "run this script" action. Every expression the
 * worker evaluates is a constant in this file, so nothing the page sends can
 * execute arbitrary code. That keeps the extension within the Web Store's
 * remote-code rules and keeps review focused on the fixed action set.
 *
 * Both ports require the token stored by the options page. A page at another
 * origin cannot open the port because of `externally_connectable`, and a page
 * at an allowed origin still has to know the token.
 */

const MODEL_PORT_NAME = 'synth-workspace-model'
const BROWSER_PORT_NAME = 'synth-workspace-browser'
const DEBUG_PROTOCOL_VERSION = '1.3'

/** id -> port, so model stream events can find the page that asked. */
const jobs = new Map()

/** Tabs currently attached by this worker. */
const attached = new Set()

class BrowserError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BrowserError'
    this.code = code
  }
}

function errorText(error) {
  if (!error) return 'the browser refused the action'
  if (typeof error === 'string') return error
  return error.message || String(error)
}

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

function post(port, message) {
  try {
    port.postMessage(message)
  } catch {
    // The page went away.
  }
}

/* --------------------------------------------------------------------------
 * Pairing
 * ------------------------------------------------------------------------ */

async function pairingToken() {
  const { pairingToken } = await chrome.storage.local.get('pairingToken')
  return typeof pairingToken === 'string' ? pairingToken : undefined
}

/* --------------------------------------------------------------------------
 * Browser control: target resolution
 * ------------------------------------------------------------------------ */

function isWebUrl(url) {
  return /^https?:/i.test(url || '')
}

/** Session storage forgets a target when Chrome closes, which is what we want. */
async function storedTarget() {
  try {
    const { browserTarget } = await chrome.storage.session.get('browserTarget')
    return typeof browserTarget === 'number' ? browserTarget : undefined
  } catch {
    return undefined
  }
}

async function rememberTarget(tabId) {
  try {
    await chrome.storage.session.set({ browserTarget: tabId })
  } catch {
    // Session storage is best effort; the active tab remains the fallback.
  }
}

/**
 * URL and title for each debuggable tab, keyed by tab id.
 *
 * `chrome.tabs.query` supplies ids and window state without the `tabs`
 * permission; its url and title fields stay empty on purpose. `getTargets`
 * supplies the page metadata instead, which is part of the `debugger`
 * permission the extension already needs. That is why the manifest asks for no
 * browsing-history access at install.
 */
async function pageTargets() {
  const byTab = new Map()
  let targets
  try {
    targets = await chrome.debugger.getTargets()
  } catch {
    return byTab
  }
  for (const target of targets || []) {
    if (!target || target.type !== 'page') continue
    if (typeof target.tabId !== 'number' || target.tabId <= 0) continue
    byTab.set(target.tabId, target)
  }
  return byTab
}

function tabInfo(tab, target) {
  const url = (target && target.url) || tab.url || ''
  const title = (target && target.title) || tab.title || ''
  return {
    targetId: String(tab.id),
    url,
    title,
    active: Boolean(tab.active),
    windowId: typeof tab.windowId === 'number' ? tab.windowId : -1,
    restricted: !isWebUrl(url),
  }
}

async function usableTab(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) return undefined
  try {
    return await chrome.tabs.get(tabId)
  } catch {
    return undefined
  }
}

/**
 * The tab an action addresses. An explicit id wins; then the tab this
 * extension last used; then the focused web tab; then any web tab. Extension
 * and chrome:// pages are skipped because Chrome refuses to debug them.
 */
async function resolveTarget(input) {
  const byTab = await pageTargets()
  const explicit = typeof input === 'number' ? input : Number(input)
  const chosen = await usableTab(explicit)
  if (chosen) {
    await rememberTarget(chosen.id)
    return { tab: chosen, target: byTab.get(chosen.id) }
  }
  const remembered = await usableTab(Number(await storedTarget()))
  if (remembered) return { tab: remembered, target: byTab.get(remembered.id) }

  const tabs = (await chrome.tabs.query({})).filter((tab) => typeof tab.id === 'number')
  const web = tabs.filter((tab) => isWebUrl((byTab.get(tab.id) || {}).url))
  const found = web.find((tab) => tab.active) || web[0] || tabs.find((tab) => tab.active)
  if (!found) throw new BrowserError('no_page', 'The browser has no open page.')
  await rememberTarget(found.id)
  return { tab: found, target: byTab.get(found.id) }
}

function assertOpenableUrl(raw) {
  const value = String(raw || '').trim()
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new BrowserError('blocked_url', 'Enter a full http(s) URL.')
  }
  const host = parsed.hostname.toLowerCase()
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  if (parsed.protocol === 'https:') return parsed.toString()
  if (parsed.protocol === 'http:' && local) return parsed.toString()
  throw new BrowserError('blocked_url', 'Only https pages and localhost may be opened.')
}

const READY_TIMEOUT_MS = 15_000
const READY_POLL_MS = 250

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Waits for a new tab to leave about:blank and finish loading. `tabs.create`
 * returns before the requested navigation commits, so readyState alone would
 * report the blank document as complete.
 */
async function waitForTab(tabId, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const target = (await pageTargets()).get(tabId)
      const tab = await chrome.tabs.get(tabId)
      if (tab.status === 'complete' && target && target.url && target.url !== 'about:blank') {
        return { tab, target }
      }
    } catch {
      return undefined
    }
    await sleep(READY_POLL_MS)
  }
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  if (!tab) return undefined
  return { tab, target: (await pageTargets()).get(tabId) }
}

/* --------------------------------------------------------------------------
 * Browser control: CDP
 * ------------------------------------------------------------------------ */

async function attach(tabId) {
  if (attached.has(tabId)) return
  try {
    await chrome.debugger.attach({ tabId }, DEBUG_PROTOCOL_VERSION)
    attached.add(tabId)
  } catch (error) {
    const message = errorText(error)
    if (/already attached/i.test(message)) {
      // It may be our own session from before a worker restart. A no-op
      // command tells an extension session apart from DevTools.
      try {
        await chrome.debugger.sendCommand(
          { tabId },
          'Runtime.evaluate',
          { expression: '1', returnByValue: true },
        )
        attached.add(tabId)
        return
      } catch {
        throw new BrowserError(
          'browser_busy',
          'Another debugger is using this tab. Close DevTools for it and try again.',
        )
      }
    }
    if (/cannot access|not allowed|chrome:|extension/i.test(message)) {
      throw new BrowserError(
        'browser_unavailable',
        'Chrome does not allow the extension to control this tab. Open a normal http(s) page.',
      )
    }
    throw new BrowserError('browser_unavailable', message)
  }
}

async function detach(tabId) {
  if (!attached.has(tabId)) return
  attached.delete(tabId)
  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // The tab or the session is already gone.
  }
}

async function withDebugger(tabId, task) {
  await attach(tabId)
  try {
    return await task()
  } finally {
    await detach(tabId)
  }
}

function send(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {})
}

async function evaluate(tabId, expression) {
  const result = await send(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result && result.exceptionDetails) {
    throw new BrowserError(
      'cdp_evaluate',
      result.exceptionDetails.text || 'the page script failed',
    )
  }
  return result && result.result ? result.result.value : undefined
}

async function waitForReady(tabId) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(tabId, 'document.readyState')
      if (state === 'complete' || state === 'interactive') return
    } catch {
      // The document is between navigations; keep polling.
    }
    await sleep(READY_POLL_MS)
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source && typeof source.tabId === 'number') attached.delete(source.tabId)
})

/* --------------------------------------------------------------------------
 * Browser control: page scripts (mirrors server/services/browser/pages.ts)
 * ------------------------------------------------------------------------ */

const MAX_TEXT = 20_000
const MAX_LINKS = 100
const MAX_FIELDS = 60

const SNAPSHOT = `(() => {
  const text = (document.body && document.body.innerText) || '';
  const links = Array.from(document.querySelectorAll('a[href]')).slice(0, ${MAX_LINKS}).map((a) => ({
    text: (a.innerText || '').trim().slice(0, 200),
    href: a.href,
  }));
  const fields = Array.from(document.querySelectorAll('input,textarea,select')).slice(0, ${MAX_FIELDS}).map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.type || '',
    name: el.name || '',
    id: el.id || '',
    placeholder: el.placeholder || '',
    label: (el.labels && el.labels[0] && el.labels[0].innerText ? el.labels[0].innerText : '').trim().slice(0, 120),
  }));
  return {
    title: document.title || '',
    url: location.href,
    text: text.slice(0, ${MAX_TEXT}),
    links,
    fields,
  };
})()`

function describeExpression(query, action, expected) {
  const literal = JSON.stringify(String(query || ''))
  const expectedJson = JSON.stringify(expected || null)
  const click = action === 'click'
  return `(() => {
  const query = ${literal};
  const expected = ${expectedJson};
  let el = null;
  try { el = document.querySelector(query); } catch (error) { el = null; }
  if (!el) {
    const candidates = Array.from(document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"],summary'));
    const textOf = (node) => ((node.innerText || node.value || '') + '').trim();
    el = candidates.find((node) => textOf(node) === query) ||
      candidates.find((node) => textOf(node).toLowerCase().includes(query.toLowerCase()));
  }
  if (!el) return { ok: false, reason: 'not_found' };
  if (expected) {
    const nowText = ((el.innerText || el.value || '') + '').trim().slice(0, 300);
    const nowHref = el.href || null;
    if (expected.text !== undefined && nowText !== expected.text) {
      return { ok: false, reason: 'changed' };
    }
    if (expected.href !== undefined && nowHref !== expected.href) {
      return { ok: false, reason: 'changed' };
    }
  }
  el.scrollIntoView({ block: 'center', inline: 'center' });
  if (el.focus) el.focus();
  const description = {
    ok: true,
    tag: el.tagName.toLowerCase(),
    type: el.type || '',
    text: ((el.innerText || el.value || '') + '').trim().slice(0, 300),
    href: el.href || null,
    name: el.name || '',
    id: el.id || '',
  };
  ${click ? 'el.click();' : ''}
  return description;
})()`
}

function focusExpression(query) {
  return `(() => {
  const query = ${JSON.stringify(String(query || ''))};
  let el = null;
  try { el = document.querySelector(query); } catch (error) { el = null; }
  if (!el) return { ok: false, reason: 'not_found' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  if (el.focus) el.focus();
  try {
    if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
      el.setSelectionRange(el.value.length, el.value.length);
    }
  } catch (error) { /* not a text field */ }
  return {
    ok: true,
    tag: el.tagName.toLowerCase(),
    type: el.type || '',
    text: ((el.innerText || el.value || '') + '').trim().slice(0, 300),
    href: el.href || null,
    name: el.name || '',
    id: el.id || '',
  };
})()`
}

const KEY_ENTER = {
  type: 'keyDown',
  key: 'Enter',
  code: 'Enter',
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
}

const KEY_ENTER_UP = { ...KEY_ENTER, type: 'keyUp' }

/* --------------------------------------------------------------------------
 * Browser control: actions
 * ------------------------------------------------------------------------ */

function numberParam(value) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

async function actionTabs() {
  const byTab = await pageTargets()
  const tabs = (await chrome.tabs.query({})).filter((tab) => typeof tab.id === 'number')
  const remembered = await usableTab(Number(await storedTarget()))
  const target =
    remembered ||
    tabs.find((tab) => tab.active && isWebUrl((byTab.get(tab.id) || {}).url)) ||
    tabs.find((tab) => isWebUrl((byTab.get(tab.id) || {}).url)) ||
    tabs.find((tab) => tab.active)
  return {
    tabs: tabs.map((tab) => tabInfo(tab, byTab.get(tab.id))),
    activeTargetId: target ? String(target.id) : null,
  }
}

async function actionOpen(params) {
  const url = assertOpenableUrl(params.url)
  const created = await chrome.tabs.create({ url, active: true })
  if (typeof created.id !== 'number') {
    throw new BrowserError('browser_unavailable', 'Chrome did not open the page.')
  }
  const ready = await waitForTab(created.id)
  await rememberTarget(created.id)
  if (ready) return tabInfo(ready.tab, ready.target)
  return tabInfo(created, (await pageTargets()).get(created.id))
}

async function actionRead(params) {
  const { tab } = await resolveTarget(numberParam(params.target))
  const snapshot = await withDebugger(tab.id, () => evaluate(tab.id, SNAPSHOT))
  return { ...(snapshot || {}), targetId: String(tab.id), untrusted: true }
}

async function actionDescribe(params) {
  const { tab } = await resolveTarget(numberParam(params.target))
  const description = await withDebugger(tab.id, () =>
    evaluate(tab.id, describeExpression(params.query, 'describe')),
  )
  return { ...(description || { ok: false, reason: 'not_found' }), targetId: String(tab.id) }
}

async function actionClick(params) {
  const { tab } = await resolveTarget(numberParam(params.target))
  if (!String(params.query || '').trim()) {
    throw new BrowserError('invalid_action', 'A click needs a selector or visible label.')
  }
  const expected =
    params.expected && typeof params.expected === 'object' ? params.expected : undefined
  const description = await withDebugger(tab.id, async () => {
    const result = await evaluate(tab.id, describeExpression(params.query, 'click', expected))
    if (result && result.ok) await waitForReady(tab.id)
    return result
  })
  return {
    ...(description || { ok: false, reason: 'not_found' }),
    targetId: String(tab.id),
    clicked: Boolean(description && description.ok),
  }
}

async function actionType(params) {
  const { tab } = await resolveTarget(numberParam(params.target))
  if (!String(params.query || '').trim()) {
    throw new BrowserError('invalid_action', 'Typing needs a selector or visible label.')
  }
  const text = typeof params.text === 'string' ? params.text : String(params.text ?? '')
  const focused = await withDebugger(tab.id, async () => {
    const result = await evaluate(tab.id, focusExpression(params.query))
    if (!result || !result.ok) return result
    if (result.type === 'password') {
      return { ...result, ok: false, reason: 'password_field' }
    }
    await send(tab.id, 'Page.bringToFront')
    await send(tab.id, 'Input.insertText', { text })
    const submitted = Boolean(params.submit)
    if (submitted) {
      await send(tab.id, 'Input.dispatchKeyEvent', KEY_ENTER)
      await send(tab.id, 'Input.dispatchKeyEvent', KEY_ENTER_UP)
    }
    return { ...result, submitted }
  })
  return {
    ...(focused || { ok: false, reason: 'not_found' }),
    targetId: String(tab.id),
    submitted: Boolean(focused && focused.submitted),
  }
}

async function actionScreenshot(params) {
  const { tab, target } = await resolveTarget(numberParam(params.target))
  const shot = await withDebugger(tab.id, () =>
    send(tab.id, 'Page.captureScreenshot', { format: 'png' }),
  )
  if (!shot || !shot.data) {
    throw new BrowserError('cdp_screenshot', 'The browser returned no image.')
  }
  return {
    ...tabInfo(tab, target),
    data: shot.data,
    dataUrl: `data:image/png;base64,${shot.data}`,
  }
}

async function actionClose(params) {
  const { tab } = await resolveTarget(numberParam(params.target))
  await chrome.tabs.remove(tab.id)
  if ((await storedTarget()) === tab.id) {
    await chrome.storage.session.remove('browserTarget').catch(() => undefined)
  }
  return { targetId: String(tab.id), closed: true }
}

async function actionActivate(params) {
  const { tab, target } = await resolveTarget(numberParam(params.target))
  await chrome.tabs.update(tab.id, { active: true })
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined)
  await rememberTarget(tab.id)
  return { ...tabInfo(tab, target), active: true }
}

async function runBrowserAction(action, params) {
  const input = params && typeof params === 'object' ? params : {}
  switch (action) {
    case 'tabs':
      return actionTabs()
    case 'open':
      return actionOpen(input)
    case 'read':
      return actionRead(input)
    case 'describe':
      return actionDescribe(input)
    case 'click':
      return actionClick(input)
    case 'type':
      return actionType(input)
    case 'screenshot':
      return actionScreenshot(input)
    case 'close':
      return actionClose(input)
    case 'activate':
      return actionActivate(input)
    default:
      throw new BrowserError('unknown_action', `Unknown browser action: ${String(action)}`)
  }
}

/* --------------------------------------------------------------------------
 * Ports
 * ------------------------------------------------------------------------ */

function modelPort(port) {
  port.onMessage.addListener(async (message) => {
    if (!message || message.type !== 'http' || typeof message.id !== 'string') return
    const token = await pairingToken()
    if (!token || message.token !== token) {
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
      fail(port, message.id, 'extension_unavailable', errorText(error))
    }
  })

  port.onDisconnect.addListener(() => {
    for (const [id, owner] of jobs) if (owner === port) jobs.delete(id)
  })
}

// One browser action at a time. Two pages (or two tabs) acting on the same tab
// would otherwise race attach/detach and one of them would lose its session.
let browserQueue = Promise.resolve()

function enqueueBrowser(task) {
  const run = browserQueue.then(task, task)
  browserQueue = run.catch(() => undefined)
  return run
}

function browserPort(port) {
  port.onMessage.addListener(async (message) => {
    if (!message || message.type !== 'browser' || typeof message.id !== 'string') return
    const token = await pairingToken()
    if (!token || message.token !== token) {
      post(port, {
        type: 'browser-result',
        id: message.id,
        ok: false,
        code: 'extension_unavailable',
        message: 'This page is not paired.',
      })
      return
    }
    try {
      const value = await enqueueBrowser(() => runBrowserAction(message.action, message.params))
      post(port, { type: 'browser-result', id: message.id, ok: true, value })
    } catch (error) {
      post(port, {
        type: 'browser-result',
        id: message.id,
        ok: false,
        code: error && error.code ? error.code : 'tool_failed',
        message: errorText(error),
      })
    }
  })
}

chrome.runtime.onConnectExternal.addListener((port) => {
  if (port.name === MODEL_PORT_NAME) modelPort(port)
  else if (port.name === BROWSER_PORT_NAME) browserPort(port)
})

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== 'background' || message.type !== 'proxy-event') return
  const event = message.event
  if (!event || typeof event.id !== 'string') return
  const port = jobs.get(event.id)
  if (!port) return
  post(port, event)
  if (event.type === 'end' || event.type === 'error') jobs.delete(event.id)
})
