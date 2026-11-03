# Synth Workspace Bridge

Chrome MV3 extension for [Synth Workspace](https://suite.synthfit.online). It
streams BYOK model calls from the browser-local PWA through your own Chrome:
no CORS proxy, your IP, and the provider key only in the in-memory headers of
one request. The extension never receives the key, OAuth tokens, chat history or
file contents beyond the request it is carrying.

Chromium browsers only (Chrome, Edge, Brave and other Chromium forks). Firefox
and Safari are not supported.

## Install (dev / unpacked)

1. Download [synth-workspace-bridge.zip](https://github.com/syntithenai/synth-workspace-bridge/releases/latest/download/synth-workspace-bridge.zip).
2. Unzip it to a folder you will keep (Chrome loads the folder, not the zip).
3. Open `chrome://extensions` and turn on **Developer mode**.
4. Choose **Load unpacked** and select the unzipped folder.
5. Open the extension's **Options** page, click **Grant network access**, then
   **Generate pairing token**.
6. In Synth Workspace open **Settings → Extension** and paste the extension id
   and token shown on the Options page.

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

- The page opens a port named `synth-workspace-model` with
  `chrome.runtime.connect(extensionId, …)`. The extension declares this origin
  in `externally_connectable`; any other origin is refused.
- The service worker checks the pairing token and hands each request to an
  offscreen document, which owns the fetch and the response stream (an MV3
  worker may be terminated mid-stream).
- Responses stream back as base64 chunks and the page rebuilds the body.
- `chrome.storage.local` holds only the pairing token. Provider keys are never
  written there.

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
git tag v0.1.0
git push origin v0.1.0
gh release create v0.1.0 dist/synth-workspace-bridge.zip \
  --title "Synth Workspace Bridge 0.1.0" \
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
a privacy-policy URL, screenshots and the same zip. Once the listing is live,
the PWA will show the store button first and keep this manual install as the
fallback. See the workspace repository's `docs/extension-publishing.md`.
