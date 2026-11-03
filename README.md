# Synth Workspace Bridge

Chrome MV3 extension for [Synth Workspace](https://suite.synthfit.online).

- **Browser control.** The workspace can list, read, open, click, type,
  screenshot and evaluate in your own tabs through Chrome's debugger protocol.
  No tab is controlled until an action is requested, and the debugger detaches
  when the action finishes.
- **Model egress.** BYOK model calls leave through your own Chrome: no CORS
  proxy, your IP, and the provider key only in the in-memory headers of one
  request. The extension never receives the key, OAuth tokens, chat history or
  file contents beyond the request it is carrying.

Chromium browsers only (Chrome, Edge, Brave and other Chromium forks). Firefox
and Safari are not supported.

## Install (dev / unpacked)

1. Download [synth-workspace-bridge.zip](https://github.com/syntithenai/synth-workspace-bridge/releases/latest/download/synth-workspace-bridge.zip).
2. Unzip it to a folder you will keep (Chrome loads the folder, not the zip).
3. Open `chrome://extensions` and turn on **Developer mode**.
4. Choose **Load unpacked** and select the unzipped folder.
5. Open the extension's **Options** page and click **Test browser control**.
   Chrome briefly attaches the debugger to an http(s) tab and shows a
   "started debugging this browser" banner; it disappears when the test ends.
   Close DevTools on that tab if the test reports it is busy.
6. Click **Grant network access**, then **Generate pairing token**.
7. In Synth Workspace open **Settings → Extension**, paste the extension id and
   token, and click **Test browser control** there too.

The extension stays installed across restarts. A Chrome Web Store listing is
planned; the unpacked and release-zip install stays available as the manual
fallback after it ships.

## Install from source

```bash
git clone https://github.com/syntithenai/synth-workspace-bridge.git
cd synth-workspace-bridge
```

Then use `extension-mv3/` as the **Load unpacked** folder from step 4 above.

## What is sent where

### Browser control

- The page opens a port named `synth-workspace-browser` with
  `chrome.runtime.connect(extensionId, …)` and sends one `browser` frame per
  action: tabs, open, read, describe, click, type, screenshot, eval, close or
  activate.
- The service worker checks the pairing token, resolves the tab (explicit id,
  then the tab it last used, then the focused web tab), attaches
  `chrome.debugger` for that action, runs it, and detaches.
- Actions mirror the workspace's server browser tools: element lookup by
  selector or visible label, password-field refusal, text insertion with an
  optional Enter, PNG screenshots and bounded expression evaluation.
- Chrome refuses debugger access to `chrome://`, the Web Store and other
  extension pages. A tab with DevTools already open cannot be driven at the
  same time.

### Model calls

- The page opens a port named `synth-workspace-model`. The extension declares
  this origin in `externally_connectable`; any other origin is refused.
- The service worker checks the pairing token and hands each request to an
  offscreen document, which owns the fetch and the response stream (an MV3
  worker may be terminated mid-stream).
- Responses stream back as base64 chunks and the page rebuilds the body.
- `chrome.storage.local` holds only the pairing token. Provider keys are never
  written there.

## Permissions

| Permission | Why |
|---|---|
| `storage` | The pairing token. |
| `offscreen` | Keeps a provider response stream alive when the worker is suspended. |
| `debugger` | Runs browser actions through the DevTools Protocol. |
| `tabs` | Lists and resolves tabs; actions need tab ids and titles. |
| Optional `https://*/*` + localhost | Provider fetches, granted by the Options button. Browser control does not use it. |

## Revoking

Options → **Revoke** deletes the pairing token; every open page is refused from
then on. Generate a new token to pair again.

## Development

```bash
bash package.sh
```

This writes `dist/synth-workspace-bridge.zip` with `manifest.json` at the
archive root.

Release:

```bash
# bump "version" in extension-mv3/manifest.json first
git tag v0.2.1
git push origin v0.2.1
gh release create v0.2.1 dist/synth-workspace-bridge.zip \
  --title "Synth Workspace Bridge 0.2.1" \
  --notes "Dev install: download the zip, unzip, then Load unpacked."
```

Keep the asset name `synth-workspace-bridge.zip` on every release: the app links
to `/releases/latest/download/synth-workspace-bridge.zip`, which only resolves
when the latest release carries that exact name.

Before publishing, bump the version in `extension-mv3/manifest.json` and in the
workspace's `EXTENSION_VERSION` constant so the UI reports the version people
actually have.

## Store publication

The Chrome Web Store listing is the next step. It needs the developer account,
a privacy-policy URL, screenshots and the same zip. Reviewers will ask about
`debugger` and the broad optional host permission: point at the Options-page
grant step, the per-action attach/detach, the password refusal, and the pairing
token that limits both ports to the workspace the user paired. See the
workspace repository's `docs/extension-publishing.md`.
