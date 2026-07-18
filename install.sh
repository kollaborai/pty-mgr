#!/bin/sh
set -e

# pty-mgr installer
# usage: curl -fsSL https://raw.githubusercontent.com/kollaborai/pty-mgr/main/install.sh | sh

REPO="kollaborai/pty-mgr"
INSTALL_DIR="$HOME/.pty-mgr/bin"

main() {
  # detect OS
  OS="$(uname -s)"
  case "$OS" in
    Linux)  OS="linux" ;;
    Darwin) OS="darwin" ;;
    *)
      echo "error: unsupported OS: $OS"
      echo "pty-mgr supports Linux and macOS only"
      exit 1
      ;;
  esac

  # detect arch
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64)  ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *)
      echo "error: unsupported architecture: $ARCH"
      echo "pty-mgr supports x64 and arm64 only"
      exit 1
      ;;
  esac

  BINARY="pty-mgr-${OS}-${ARCH}"

  # get latest release tag
  echo "fetching latest release..."
  TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | cut -d'"' -f4)

  if [ -z "$TAG" ]; then
    echo "error: could not find latest release"
    echo "check https://github.com/${REPO}/releases"
    exit 1
  fi

  URL="https://github.com/${REPO}/releases/download/${TAG}/${BINARY}"

  echo "installing pty-mgr ${TAG} (${OS}/${ARCH})..."

  # create install dir
  mkdir -p "$INSTALL_DIR"

  # download binary
  curl -fsSL "$URL" -o "${INSTALL_DIR}/pty-mgr"
  chmod +x "${INSTALL_DIR}/pty-mgr"

  # macOS: ad-hoc re-sign against the downloaded bytes. Apple Silicon (AMFI)
  # SIGKILLs binaries whose signature is invalid; re-signing makes it valid.
  # Belt-and-suspenders: release binaries are already signed in CI, but this
  # covers older releases and any download that altered the bytes.
  if [ "$OS" = "darwin" ] && command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "${INSTALL_DIR}/pty-mgr" 2>/dev/null \
      || echo "warning: codesign failed; if you see 'killed', run: codesign --force --sign - ${INSTALL_DIR}/pty-mgr"
  fi

  # create p symlink
  ln -sf pty-mgr "${INSTALL_DIR}/p"

  # add to PATH if not already there
  add_to_path

  echo ""
  echo "installed: ${INSTALL_DIR}/pty-mgr (${TAG})"
  echo "commands:  pty-mgr, p"
  echo ""

  # check if PATH is active in current shell
  case ":$PATH:" in
    *":${INSTALL_DIR}:"*)
      echo "PATH is set."
      ;;
    *)
      echo "restart your shell or run:"
      echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
      echo ""
      ;;
  esac

  warn_conflicts

  echo "to wrap CLI tools (claude, codex, etc.) in managed sessions:"
  echo "  pty-mgr setup"
  echo ""
}

# Report other pty-mgr copies on PATH. INSTALL_DIR is prepended, so these lose
# in a fresh login shell -- but they win in shells started before this install
# and in non-interactive shells that never source an rc file. That failure is
# silent: the CLI still runs, it just isn't the version you installed.
warn_conflicts() {
  CONFLICTS="$(find_conflicts)"
  [ -n "$CONFLICTS" ] || return 0

  echo "warning: other pty-mgr commands found on PATH:"
  printf '%s\n' "$CONFLICTS" | sed 's/^/    /'
  echo ""
  echo "  these shadow ${INSTALL_DIR} in shells started before this install and"
  echo "  in non-interactive shells that skip your rc file. remove them with:"
  echo "    rm $(printf '%s' "$CONFLICTS" | tr '\n' ' ')"
  echo ""
}

find_conflicts() {
  OLD_IFS="$IFS"
  IFS=:
  for DIR in $PATH; do
    # empty entry means cwd; never treat it as an install location
    [ -n "$DIR" ] || continue
    [ "$DIR" = "$INSTALL_DIR" ] && continue
    for CMD in pty-mgr p; do
      TARGET="${DIR}/${CMD}"
      # -f follows symlinks and excludes directories
      { [ -f "$TARGET" ] && [ -x "$TARGET" ]; } || continue
      # `p` is a common name; only flag one that points at a pty-mgr binary
      if [ "$CMD" = "p" ]; then
        case "$(readlink "$TARGET" 2>/dev/null)" in
          *pty-mgr*) ;;
          *) continue ;;
        esac
      fi
      printf '%s\n' "$TARGET"
    done
  done
  IFS="$OLD_IFS"
}

add_to_path() {
  PATH_LINE="export PATH=\"${INSTALL_DIR}:\$PATH\""

  for RC in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$RC" ]; then
      if ! grep -qF "$INSTALL_DIR" "$RC" 2>/dev/null; then
        echo "" >> "$RC"
        echo "# pty-mgr" >> "$RC"
        echo "$PATH_LINE" >> "$RC"
      fi
    fi
  done

  # create .zshrc if on macOS and it doesn't exist (zsh is default)
  if [ "$OS" = "darwin" ] && [ ! -f "$HOME/.zshrc" ]; then
    echo "# pty-mgr" > "$HOME/.zshrc"
    echo "$PATH_LINE" >> "$HOME/.zshrc"
  fi
}

main
