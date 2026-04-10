#!/bin/bash
# Setup script to copy devcontainer config to local.json if it doesn't exist

set -e

CONFIG_DIR="apps/web/config"
LOCAL_CONFIG="$CONFIG_DIR/local.json"
DEVCONTAINER_CONFIG="$CONFIG_DIR/devcontainer.json"

if [ ! -f "$LOCAL_CONFIG" ]; then
  echo "Creating $LOCAL_CONFIG from devcontainer template..."
  cp "$DEVCONTAINER_CONFIG" "$LOCAL_CONFIG"
  echo "Local config created successfully."
else
  echo "$LOCAL_CONFIG already exists, skipping."
fi
