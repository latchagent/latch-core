# Releasing Latch Desktop (macOS)

## Prerequisites

### 1. Apple Developer credentials

You need these **once** — they're already set up in your GitHub repo secrets:

| Secret | What it is |
|--------|-----------|
| `MACOS_CERTIFICATE` | Base64-encoded `.p12` of your "Developer ID Application" cert |
| `MACOS_CERTIFICATE_PWD` | Password for the `.p12` file |
| `KEYCHAIN_PWD` | Arbitrary password for the ephemeral CI keychain |
| `APPLE_ID` | Your Apple ID email (for notarization) |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | Your team ID (yours is `C7XDHWD495`) |

### 2. Export your certificate as .p12

If you haven't done this yet:

```bash
# Open Keychain Access → "Developer ID Application: Christian Bryant"
# Right-click → Export → save as dev-id.p12 (set a password)

# Convert to base64 for the GitHub secret:
base64 -i dev-id.p12 -o dev-id.b64
cat dev-id.b64 | pbcopy
```

### 3. Create an app-specific password

1. Go to https://appleid.apple.com → Sign-In and Security → App-Specific Passwords
2. Generate one, label it "Latch Notarize"
3. Save it as the `APPLE_APP_SPECIFIC_PASSWORD` secret

### 4. Add secrets to GitHub

```bash
gh secret set MACOS_CERTIFICATE < dev-id.b64
gh secret set MACOS_CERTIFICATE_PWD
gh secret set KEYCHAIN_PWD
gh secret set APPLE_ID
gh secret set APPLE_APP_SPECIFIC_PASSWORD
gh secret set APPLE_TEAM_ID
```

---

## Cutting a release

### 1. Bump the version

```bash
# Edit package.json → "version": "0.2.0"
npm version 0.2.0 --no-git-tag-version
```

### 2. Commit and tag

```bash
git add package.json
git commit -m "release: v0.2.0"
git tag v0.2.0
git push origin main --tags
```

### 3. Watch the build

The `release.yml` workflow triggers automatically on the `v*` tag push:

```bash
gh run watch          # watch the latest run
gh run list           # or find it by name
```

### 4. What the workflow does

1. Checks out the tagged commit
2. `npm ci` + `npm run build` (electron-vite)
3. Imports your Developer ID cert into an ephemeral keychain
4. `electron-builder --mac --universal --publish always`:
   - Builds a **universal** binary (arm64 + x64 in one app)
   - Signs with your Developer ID certificate
   - Notarizes with Apple (via `build/notarize.js`)
   - Uploads `.dmg` + `.zip` to a GitHub Release for the tag
   - Uploads `latest-mac.yml` (used by the in-app auto-updater)
5. Cleans up the keychain

### 5. Verify the release

```bash
gh release view v0.2.0
```

The release will contain:
- `Latch-0.2.0-universal.dmg` — drag-to-Applications installer
- `Latch-0.2.0-universal.zip` — used by the auto-updater
- `latest-mac.yml` — version manifest for electron-updater

---

## Website download link

Point your website's download button at the latest release DMG:

```
https://github.com/latchagent/latch-core/releases/latest/download/Latch-{version}-universal.dmg
```

Or use the GitHub API to resolve the latest version dynamically:

```js
const res = await fetch('https://api.github.com/repos/latchagent/latch-core/releases/latest')
const { tag_name, assets } = await res.json()
const dmg = assets.find(a => a.name.endsWith('.dmg'))
// dmg.browser_download_url → direct download link
```

For a stable "always latest" URL that redirects:
```
https://github.com/latchagent/latch-core/releases/latest
```

---

## In-app auto-update flow

The app ships with `electron-updater` which:

1. **Checks for updates** 10 seconds after launch (and on `latch:updater-check` IPC)
2. Reads `latest-mac.yml` from your GitHub Releases
3. If a newer version exists, shows an **update banner** at the top of the app
4. User clicks **Download** → streams the `.zip` with a progress bar
5. User clicks **Restart Now** → `autoUpdater.quitAndInstall()` swaps the app bundle

No server infrastructure needed — GitHub Releases is the update server.

---

## Manual / local build (for testing)

```bash
# Build + package locally (not signed, not notarized)
npm run dist

# Build signed + notarized locally (requires env vars)
export APPLE_ID="your@email.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="C7XDHWD495"
npx electron-builder --mac --universal
```

Output goes to `dist/`.

---

## Troubleshooting

### "The application is damaged" on first open
The app wasn't notarized. Check:
- `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` secrets are correct
- The `afterSign` notarize script ran (check CI logs)

### Notarization times out
Apple's service can be slow. The workflow has a 30-minute timeout. If it's consistently failing, check https://developer.apple.com/system-status/

### electron-updater doesn't find updates
- The `publish` config in `package.json` must match the repo owner/name
- The `latest-mac.yml` file must exist in the release assets
- The app's `version` in `package.json` must be lower than the release tag

### Code signing identity not found in CI
- Re-export the `.p12` and update the `MACOS_CERTIFICATE` secret
- Make sure the cert hasn't expired (check in Keychain Access)
