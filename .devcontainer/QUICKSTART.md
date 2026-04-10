# Bitwarden Web Vault Quick Start

Get the Bitwarden Web Vault running locally with HTTPS and Firefox in under 5 minutes.

## Prerequisites

- VS Code with Dev Containers extension
- Docker Desktop
- Repository cloned and opened in dev container

## Quick Start

### 1. Start the Web Vault

The dev container automatically sets up the web vault configuration. Once the container is running, simply start the dev server:

In the VS Code terminal (inside the dev container):

```bash
nx serve web
```

Wait for the build to complete. You'll see:

```
<i> [webpack-dev-server] Project is running at:
<i> [webpack-dev-server] Loopback: https://localhost:443/
```

### 2. Launch Firefox

```bash
firefox-dev https://vault.qa.bitwarden.pw
```

Or open Firefox and navigate to: `https://vault.qa.bitwarden.pw`

## Troubleshooting

### Certificate Permission Issues

If you encounter "EACCES: permission denied" when starting the web vault:

```bash
sudo chown -R node:node /usr/local/share/ca-certificates/dev/
```

### Firefox shows certificate warning every time

Re-run the certificate setup:

```bash
setup-dev-certs.sh
```

Then restart Firefox.

### API calls failing (404 errors)

The dev server proxies API requests to the QA environment. Ensure:

- You're accessing via `https://vault.qa.bitwarden.pw` (not localhost)
- The proxy configuration in `apps/web/config/local.json` has correct QA URLs

## Firefox Extension Development

### Build the Firefox Extension

```bash
export CI=true
# Firefox with Manifest V3 (modern)
nx build browser --configuration=firefox-dev

# Firefox with Manifest V2 (older format)
nx build browser --configuration=firefox-mv2-dev
```

**Build with watch mode (rebuilds on changes):**

```bash
export CI=true

# Manifest V3
nx serve browser --configuration=firefox-dev

# Manifest V2
nx serve browser --configuration=firefox-mv2-dev
```

### Load in Firefox

- Navigate to `about:debugging` in Firefox

- Click **"This Firefox"**

- Click **"Load Temporary Add-on..."**

- Select the `manifest.json` file from:
  - `dist/apps/browser/firefox-dev/manifest.json` (for MV3)
  - OR `dist/apps/browser/firefox-mv2-dev/manifest.json` (for MV2)

### Watch Mode (Auto-rebuild on Changes)

```bash
nx serve browser --configuration=firefox-dev
```

Then reload the extension in Firefox's `about:debugging` page after changes.

## Next Steps

- See [README.md](README.md) for full dev container documentation
- See [apps/web/README.md](../apps/web/README.md) for web vault specific docs
- See [apps/browser/README.md](../apps/browser/README.md) for browser extension docs
- Visit [contributing.bitwarden.com](https://contributing.bitwarden.com/) for comprehensive guides
