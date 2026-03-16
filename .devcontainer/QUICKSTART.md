# Bitwarden Web Vault Quick Start

Get the Bitwarden Web Vault running locally with HTTPS and Firefox in under 5 minutes.

## Prerequisites

- VS Code with Dev Containers extension
- Docker Desktop
- Repository cloned and opened in dev container

## Quick Start

### 1. Start the Web Vault

In the VS Code terminal (inside the dev container):

```bash
nx serve web
```

Wait for the build to complete. You'll see:

```
<i> [webpack-dev-server] Project is running at:
<i> [webpack-dev-server] Loopback: https://localhost:443/
```

### 2. Setup Firefox Certificates (First Time Only)

In a new terminal:

```bash
setup-dev-certs.sh
```

This installs the development Root CA into Firefox's certificate store.

### 3. Launch Firefox

```bash
firefox-dev https://vault.bitwarden.localhost
```

Or open Firefox and navigate to: `https://vault.bitwarden.localhost`

### 4. Accept Certificate Warning

On first access, Firefox will show a certificate warning. Click **"Advanced"** → **"Accept the Risk and Continue"**.

> **Note**: This is expected because we're using self-signed certificates for local development.

## Common Commands

| Command                                   | Description                         |
| ----------------------------------------- | ----------------------------------- |
| `nx serve web`                            | Start the web vault dev server      |
| `nx serve web --configuration=commercial` | Start with commercial features      |
| `firefox-dev`                             | Launch Firefox with dev profile     |
| `firefox-dev <url>`                       | Launch Firefox and open URL         |
| `setup-dev-certs.sh`                      | Install dev certificates in Firefox |

## How It Works

- **Local Domain**: `vault.bitwarden.localhost` resolves to 127.0.0.1
- **HTTPS**: Self-signed TLS certificates for `vault.bitwarden.localhost`
- **API Proxying**: Requests to `/api`, `/identity`, etc. are proxied to `*.qa.bitwarden.pw`
- **Firefox**: Custom profile with dev certificates pre-installed

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

- You're accessing via `https://vault.bitwarden.localhost` (not localhost)
- The proxy configuration in `apps/web/config/local.json` has correct QA URLs

## Next Steps

- See [README.md](README.md) for full dev container documentation
- See [apps/web/README.md](../apps/web/README.md) for web vault specific docs
- Visit [contributing.bitwarden.com](https://contributing.bitwarden.com/) for comprehensive guides
