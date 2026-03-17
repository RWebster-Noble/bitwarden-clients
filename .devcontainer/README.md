# Bitwarden Clients Dev Container

This directory contains the VS Code Dev Container configuration for the Bitwarden Clients monorepo, providing a consistent, reproducible development environment.

## What's Included

The dev container is pre-configured with all necessary tools and dependencies for developing Bitwarden client applications:

### Runtime & Languages

- **Node.js 22** - Matches `.nvmrc` and `package.json` requirements
- **TypeScript 5.8+** - Full TypeScript support
- **Rust** - Required for building desktop native modules (`apps/desktop/desktop_native`)
- **Python 3** - Build tooling for native dependencies

### Frameworks & Tools

- **Angular CLI 20** - For Angular development
- **Nx 21.6.10** - Monorepo build system
- **npm 10** - Package manager

### VS Code Extensions

Pre-installed extensions for optimal development experience:

| Category   | Extensions                                           |
| ---------- | ---------------------------------------------------- |
| Angular/Nx | Angular Language Service, Nx Console                 |
| TypeScript | ESLint, Prettier, TypeScript Next                    |
| Testing    | Jest, Jest Runner                                    |
| Rust       | Rust Analyzer, CodeLLDB                              |
| Git        | GitLens, GitHub Pull Requests                        |
| Utilities  | EditorConfig, Tailwind CSS, YAML, Code Spell Checker |

### System Dependencies

- Electron runtime libraries (GTK, D-Bus, etc.)
- Build essentials (gcc, make, etc.)
- Git LFS
- Docker-in-Docker support
- **Firefox ESR** - For browser extension testing
- **NSS tools** - For Firefox certificate management

## Getting Started

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed
- [VS Code](https://code.visualstudio.com/) with [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)

### Opening the Project

1. Clone the repository:

   ```bash
   git clone https://github.com/bitwarden/clients.git
   cd clients
   ```

2. Open in VS Code:

   ```bash
   code .
   ```

3. When prompted, click "Reopen in Container" or run the command:
   - **Ctrl+Shift+P** (or **Cmd+Shift+P** on macOS) → "Dev Containers: Reopen in Container"

4. Wait for the container to build and `npm ci` to complete (this may take several minutes on first run).

### Post-Container Setup

Once the container is running, all dependencies are automatically installed. You can verify with:

```bash
# Check Node.js version
node --version  # Should be v22.x.x

# Check npm version
npm --version   # Should be 10.x.x

# Check Angular CLI
ng version

# Check Rust toolchain
cargo --version
rustc --version

# Check Nx
nx --version
```

## Development Workflows

### Web Vault (apps/web) with QA Proxy

The dev container is configured to run the Web Vault with HTTPS using custom TLS certificates and proxy API requests to the Bitwarden QA environment.

#### How It Works

1. **Local Domain**: `vault.qa.bitwarden.pw` resolves to 127.0.0.1 via `/etc/hosts` and Docker `--add-host`
2. **TLS Certificates**: Self-signed certificates for `vault.qa.bitwarden.pw`:
   - Root CA: `/usr/local/share/ca-certificates/dev/rootCA.crt`
   - Vault certificate: `/usr/local/share/ca-certificates/dev/vault.crt`
   - Vault key: `/usr/local/share/ca-certificates/dev/vault.key`
3. **API Proxying**: The webpack dev server proxies API requests to the real QA environment:
   - `/api` → `https://api.qa.bitwarden.pw`
   - `/identity` → `https://identity.qa.bitwarden.pw`
   - `/events` → `https://events.qa.bitwarden.pw`
   - `/notifications` → `https://notifications.qa.bitwarden.pw`
   - `/icons` → `https://icons.qa.bitwarden.pw`

#### Running the Web Vault

```bash
# Serve the web vault with local dev configuration
nx serve web
```

Access the web vault at: `https://vault.qa.bitwarden.pw`

#### Using Firefox in the Container

Firefox ESR is pre-installed with scripts to manage development certificates:

```bash
# Setup Firefox certificates (run once or after container rebuild)
setup-dev-certs.sh

# Launch Firefox with the dev profile
firefox-dev

# Or directly with a URL
firefox-dev https://vault.qa.bitwarden.pw
```

**Note**: When first accessing the site in Firefox, you'll need to accept the self-signed certificate exception since the Root CA is only trusted within the container's system store, not Firefox's certificate store.

#### Trusting the Root CA in Firefox

The `setup-dev-certs.sh` script automatically configures Firefox to trust the development Root CA. If you encounter certificate warnings:

1. Run `setup-dev-certs.sh` to ensure the certificate is installed
2. In Firefox, navigate to `about:preferences#privacy` → "View Certificates" → "Authorities"
3. Verify "Bitwarden Dev Root CA" is listed

### Desktop App (apps/desktop)

```bash
# Build native modules first
cd apps/desktop/desktop_native && cargo build --release

# Return to root and serve desktop app
cd ../../..
nx serve desktop
```

### Browser Extension (apps/browser)

```bash
# Build browser extension
nx build browser

# Run tests
nx test browser
```

### Storybook

```bash
# Run Storybook for UI components
npm run storybook
```

Access at: http://localhost:6006 (auto-forwarded from container)

### Running Tests

```bash
# Run all tests
npm test

# Run tests for specific project
nx test <project-name>

# Run tests in watch mode
nx test <project-name> --watch
```

### Linting

```bash
# Run linter
npm run lint

# Fix linting issues
npm run lint:fix

# Run prettier
npm run prettier
```

## Container Features

### Port Forwarding

The following ports are automatically forwarded:

| Port | Application          | Access                 |
| ---- | -------------------- | ---------------------- |
| 4200 | Web Vault Dev Server | http://localhost:4200  |
| 6006 | Storybook            | http://localhost:6006  |
| 8080 | Webpack Dev Server   | http://localhost:8080  |
| 3443 | HTTPS Dev Server     | https://localhost:3443 |
| 5000 | API Server           | http://localhost:5000  |

### TLS Certificates

Development certificates are automatically generated during container build:

- **Location**: `/usr/local/share/ca-certificates/dev/`
- **Certificate**: `vault.crt` (for `vault.qa.bitwarden.pw`)
- **Key**: `vault.key`
- **Root CA**: `rootCA.crt`

The Root CA is automatically trusted in the container's system certificate store via `update-ca-certificates`.

### Firefox Configuration

Firefox-specific configuration includes:

- **Profile directory**: `/home/node/.mozilla/firefox/dev-profile`
- **Certificate script**: `setup-dev-certs.sh` - installs Root CA in Firefox's NSS database
- **Launch script**: `firefox-dev` - launches Firefox with the dev profile

### GitHub CLI

Pre-installed for interacting with GitHub from the command line:

```bash
# Authenticate
gh auth login

# Create a pull request
gh pr create

# View workflow runs
gh run list
```

## Configuration

### devcontainer.json

The main configuration file (`devcontainer.json`) defines:

- Base image and build configuration
- Dev Container Features to install
- VS Code extensions and settings
- Port forwarding
- Post-create commands
- Environment variables
- **Host entry** for `vault.qa.bitwarden.pw` → `127.0.0.1`

### Dockerfile

Custom Dockerfile (`Dockerfile`) extends the base TypeScript-Node image with:

- Electron system dependencies
- Firefox ESR and NSS tools for certificate management
- **Self-signed certificate generation** for `vault.qa.bitwarden.pw`
- Global npm packages (Angular CLI, Nx)

## Troubleshooting

### Container Build Issues

If the container fails to build:

1. **Check Docker resources**: Ensure Docker has sufficient memory (minimum 8GB recommended)
2. **Clear Docker cache**: `docker system prune -a`
3. **Rebuild container**: F1 → "Dev Containers: Rebuild Container"

### npm ci Failures

If `npm ci` fails during container creation:

1. Check your network connection
2. Clear npm cache: `npm cache clean --force`
3. Rebuild the container: F1 → "Dev Containers: Rebuild Container"

### Rust Build Issues

For desktop native module compilation issues:

```bash
# Update Rust toolchain
rustup update

# Check Rust installation
rustup show

# Build native modules manually
cd apps/desktop/desktop_native
cargo build --release
```

### Certificate Permission Issues

If you encounter "EACCES: permission denied" when starting the web vault:

```bash
# Fix certificate ownership
sudo chown -R node:node /usr/local/share/ca-certificates/dev/
```

### Firefox Certificate Warnings

If Firefox shows certificate warnings for `https://vault.qa.bitwarden.pw`:

1. Run the certificate setup script:
   ```bash
   setup-dev-certs.sh
   ```
2. Restart Firefox if it was already running
3. Accept the certificate exception in Firefox if prompted

### API Proxy Issues

If API calls are failing (404 errors):

- Ensure you're accessing via `https://vault.qa.bitwarden.pw`
- The webpack dev server proxies `/api`, `/identity`, etc. to the QA environment
- Check that `apps/web/config/local.json` has the correct QA proxy URLs

### Performance

If the container feels slow:

1. **Increase Docker resources**: Allocate more CPU and memory in Docker Desktop
2. **Enable BuildKit**: Set `DOCKER_BUILDKIT=1` in your environment
3. **Use volume mounts**: Ensure the workspace is mounted as a volume (default behavior)

## Customization

### Adding Extensions

Add VS Code extensions to `devcontainer.json`:

```json
"customizations": {
  "vscode": {
    "extensions": [
      "your.extension-name"
    ]
  }
}
```

### Adding Features

Add Dev Container Features from [containers.dev/features](https://containers.dev/features):

```json
"features": {
  "ghcr.io/devcontainers/features/<feature-name>:1": {}
}
```

### Environment Variables

Add environment variables to `devcontainer.json`:

```json
"containerEnv": {
  "YOUR_VARIABLE": "value"
}
```

## Updating the Container

When `devcontainer.json` or `Dockerfile` changes:

1. F1 → "Dev Containers: Rebuild Container"
2. Or use the notification that appears when configuration changes are detected

## GitHub Codespaces

This dev container is compatible with [GitHub Codespaces](https://github.com/features/codespaces). Simply:

1. Push the repository to GitHub
2. Click "Code" → "Codespaces" → "Create codespace on main"

## Additional Resources

- [Bitwarden Contributing Guide](https://contributing.bitwarden.com/)
- [Dev Containers Documentation](https://code.visualstudio.com/docs/devcontainers/containers)
- [Nx Documentation](https://nx.dev/)
- [Angular Documentation](https://angular.dev/)

## Support

For issues or questions:

- [Bitwarden GitHub Issues](https://github.com/bitwarden/clients/issues)
- [Bitwarden Community Forums](https://community.bitwarden.com/)
