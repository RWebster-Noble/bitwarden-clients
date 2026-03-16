# Bitwarden Clients Dev Container
# Custom Dockerfile extending the TypeScript-Node base image

FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# Avoid warnings by switching to noninteractive
ENV DEBIAN_FRONTEND=noninteractive

# Install additional system dependencies for Electron and browser extension development
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Electron dependencies for running desktop app in container
    libgtk-3-0 \
    libnotify4 \
    libnss3 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    libatspi2.0-0 \
    libuuid1 \
    libsecret-1-0 \
    # Additional libraries for native modules
    libglib2.0-bin \
    libdbus-1-3 \
    libgtk-3-bin \
    libdrm2 \
    libgbm1 \
    libxcb-dri3-0 \
    libxshmfence1 \
    # Build tools for native dependencies
    build-essential \
    python3 \
    python3-pip \
    # Utilities
    curl \
    wget \
    ca-certificates \
    gnupg \
    lsb-release \
    # Firefox ESR for browser extension testing
    firefox-esr \
    # OpenSSL for certificate generation
    openssl \
    # NSS tools for Firefox certificate management
    libnss3-tools \
    # X11 libraries for Firefox display
    libdbus-glib-1-2 \
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxi6 \
    libxrandr2 \
    libxss1 \
    libxt6 \
    libpci3 \
    # Cleanup
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install global npm packages for convenience
RUN npm install -g \
    @angular/cli@20 \
    nx@21.6.10 \
    && npm cache clean --force

# Create directory for development certificates
RUN mkdir -p /usr/local/share/ca-certificates/dev

# Generate self-signed Root CA
RUN openssl genrsa -out /usr/local/share/ca-certificates/dev/rootCA.key 4096 && \
    openssl req -x509 -new -nodes -key /usr/local/share/ca-certificates/dev/rootCA.key \
    -sha256 -days 3650 -out /usr/local/share/ca-certificates/dev/rootCA.crt \
    -subj "/C=US/ST=Dev/L=Dev/O=Bitwarden Dev/CN=Bitwarden Dev Root CA"

# Generate certificate for vault.bitwarden.localhost
COPY <<CERTSCRIPT /tmp/gen-cert.sh
#!/bin/bash
cd /usr/local/share/ca-certificates/dev
openssl genrsa -out vault.key 2048
openssl req -new -key vault.key -out vault.csr -subj "/C=US/ST=Dev/L=Dev/O=Bitwarden Dev/CN=vault.bitwarden.localhost"
openssl x509 -req -in vault.csr -CA rootCA.crt -CAkey rootCA.key -CAcreateserial -out vault.crt -days 365 -sha256 -extfile <(printf "subjectAltName=DNS:vault.bitwarden.localhost,DNS:localhost,DNS:*.bitwarden.localhost")
rm vault.csr
CERTSCRIPT

RUN chmod +x /tmp/gen-cert.sh && /tmp/gen-cert.sh

# Trust the root CA in the system
RUN cp /usr/local/share/ca-certificates/dev/rootCA.crt /usr/local/share/ca-certificates/ && \
    update-ca-certificates

# Set proper permissions on certificate files
RUN chmod 644 /usr/local/share/ca-certificates/dev/vault.crt && \
    chmod 600 /usr/local/share/ca-certificates/dev/vault.key && \
    chmod 644 /usr/local/share/ca-certificates/dev/rootCA.crt && \
    chmod 600 /usr/local/share/ca-certificates/dev/rootCA.key

# Change ownership to node user for dev server access
RUN chown -R node:node /usr/local/share/ca-certificates/dev/

# Add node user to input group for UHID device access (FIDO2 token support)
# Create the input group if it doesn't exist (not present in all base images)
RUN groupadd -f input && usermod -a -G input node

# Create certificate setup script for Firefox
COPY <<'SETUPSCRIPT' /usr/local/bin/setup-dev-certs.sh
#!/bin/bash
set -e

echo "Setting up development certificates for Firefox..."

# Create Firefox profile directory if it doesn't exist
FIREFOX_PROFILE_DIR="/home/node/.mozilla/firefox/dev-profile"
mkdir -p "$FIREFOX_PROFILE_DIR"

# Initialize NSS database if it doesn't exist
if [ ! -f "$FIREFOX_PROFILE_DIR/cert9.db" ]; then
    certutil -N -d "sql:$FIREFOX_PROFILE_DIR" --empty-password
fi

# Add root CA to Firefox trust store
certutil -A -n "Bitwarden Dev Root CA" -t "C,," -i /usr/local/share/ca-certificates/dev/rootCA.crt -d "sql:$FIREFOX_PROFILE_DIR" || true

# Set ownership to node user
chown -R node:node /home/node/.mozilla

echo "Development certificates configured for Firefox"
SETUPSCRIPT

RUN chmod +x /usr/local/bin/setup-dev-certs.sh

# Create Firefox launch script with the dev profile
COPY <<'FIREFOXSCRIPT' /usr/local/bin/firefox-dev
#!/bin/bash
FIREFOX_PROFILE_DIR="/home/node/.mozilla/firefox/dev-profile"
mkdir -p "$FIREFOX_PROFILE_DIR"
firefox-esr --profile "$FIREFOX_PROFILE_DIR" "$@"
FIREFOXSCRIPT

RUN chmod +x /usr/local/bin/firefox-dev

# Switch back to dialog for any ad-hoc use of apt-get
ENV DEBIAN_FRONTEND=dialog
