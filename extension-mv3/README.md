# Synth Workspace Bridge (Chrome MV3)

Gives Synth Workspace control of your own browser and makes the extension the
PWA's primary network egress for BYO model calls.

- **Browser control.** The workspace can list, read, open, click, type,
  screenshot and evaluate in your tabs through Chrome's debugger protocol — the
  same mechanism DevTools uses. Actions run in the tab you are already signed
  in to, and no tab is controlled until an action is requested.
- **Model egress.** Provider requests leave through your own Chrome, need no
  CORS headers, and the API key is only ever in the in-memory headers of one
  request — never in `chrome.storage`, IndexedDB, localStorage, the Worker, or a
  log.

**Canonical source:** <https://github.com/syntithenai/synth-workspace-bridge>.
This folder is the working copy; publish changes there with
`npm run extension:package` and a new release tag.

## Install (dev, unpacked)

1. Download
   [synth-workspace-bridge.zip](https://github.com/syntithenai/synth-workspace-bridge/releases/latest/download/synth-workspace-bridge.zip)
   and unzip it to a folder you will keep.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the unzipped folder. (Working from a
   clone? Select this `extension-mv3/` directory instead.)
4. Open the extension's **Options** page and choose **Test browser control**.
   The first test attaches the debugger to an http(s) tab for a moment; Chrome
   shows a "started debugging this browser" banner and removes it afterwards.
   DevTools open on that tab blocks the test — close it and retry.
5. **Grant network access** (Chrome asks once for the host permission).
6. **Generate pairing token**. Copy the extension id and token.
7. In Synth Workspace open **Settings → Extension** and paste both. Use
   **Test browser control** there to confirm the pairing.

A Chrome Web Store listing is planned; the manual install stays available as
the fallback after it ships. See
[`docs/extension-publishing.md`](../docs/extension-publishing.md).

The extension declares `externally_connectable` for
`https://suite.synthfit.online` and for localhost development origins only.
A page from any other origin cannot open either port.

## What is sent where

### Browser control

- The page opens
  `chrome.runtime.connect(extensionId, { name: 'synth-workspace-browser' })`
  and sends one `browser` frame:
  `{ action, params: { target?, url?, query?, text?, script?, submit?, expected? } }`.
- The service worker checks the pairing token, resolves the tab (explicit id,
  then the tab it last used, then the focused web tab), attaches
  `chrome.debugger` for that one action, runs it, and detaches.
- Actions mirror the server's browser tools: element lookup by selector or
  visible label, password-field refusal, `Input.insertText` typing with an
  optional Enter, `Page.captureScreenshot`, and `Runtime.evaluate` with
  `returnByValue` and `awaitPromise`.
- Page text is returned to the workspace marked untrusted. Password and
  credential fields are never read or filled. A click may carry the text and
  href the user approved; if the page changed underneath, it returns `changed`
  instead of clicking something else.
- Chrome refuses debugger access to `chrome://`, the Web Store and other
  extension pages; the extension reports `browser_unavailable` for those.
- A tab with DevTools open cannot be driven at the same time; the extension
  reports `browser_busy` rather than fighting for the session.

### Model calls

- The page sends one `http` frame per provider call over
  `chrome.runtime.connect(extensionId, { name: 'synth-workspace-model' })`.
- The service worker checks the pairing token and hands the request to an
  offscreen document, which owns the fetch and the response stream (an MV3
  worker may be terminated mid-stream).
- Provider responses stream back as base64 chunks; the page rebuilds the SSE
  body. The provider key is never written anywhere.

## Permissions

| Permission | Why |
|---|---|
| `storage` | The pairing token, kept in `chrome.storage.local`. |
| `offscreen` | Keeps a provider response stream alive when the worker is suspended. |
| `debugger` | Runs browser actions through the DevTools Protocol. |
| `tabs` | Lists and resolves tabs; browser actions need tab ids and titles. |
| Optional `https://*/*` + localhost | Provider fetches, granted on the Options page. Browser control does not use it. |

## Revoking

Options → **Revoke** deletes the pairing token; every open page is refused from
then on. Regenerate to pair again.

## Limits

- Chromium browsers only (Chrome/Edge/Brave). No Firefox/Safari.
- No provider call or browser action happens while Chrome is closed.
- Browser control acts only in normal http(s) tabs, never in browser-internal
  pages.
- The Worker `/api/model/*` proxy is the fallback when the extension is not
  paired; it forwards the key per request and stores nothing.
