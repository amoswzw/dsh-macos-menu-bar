#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
  printf '%s\n' 'dsh-macos-menu-bar requires macOS.' >&2
  exit 1
fi

dsh_cli=${DSH_CLI:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}
if [ ! -x "$dsh_cli" ]; then
  printf '%s\n' 'DeepSeek Harness CLI not found. Set DSH_CLI to its executable path.' >&2
  exit 1
fi

source=${1:-github:amoswzw/dsh-macos-menu-bar}
exec "$dsh_cli" plugin --profile desktop add "$source"
