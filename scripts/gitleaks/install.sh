#!/usr/bin/env bash
#
# Install the pinned gitleaks: bash scripts/gitleaks/install.sh [dir]
#
# Downloads the release asset for this platform, checks its sha256 against
# pin.env beside this script, and installs the binary into <dir> (default
# ~/.local/bin). A checksum mismatch, a missing checksum or an unsupported
# platform is a refusal: there is no unchecked fallback. Does nothing when
# <dir> already holds the pinned version.
#
# Copied unchanged into every repository that runs gitleaks; keep it generic.

set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=pin.env
. "$here/pin.env"

die() {
    echo "gitleaks install: $*" >&2
    exit 1
}

[ -n "${GITLEAKS_VERSION:-}" ] || die "GITLEAKS_VERSION is not set in $here/pin.env"

dir=${1:-$HOME/.local/bin}

case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT) os=windows ;;
    *) die "unsupported operating system: $(uname -s)" ;;
esac
case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "unsupported architecture: $(uname -m)" ;;
esac

if [ "$os" = windows ]; then
    ext=zip
    exe=gitleaks.exe
else
    ext=tar.gz
    exe=gitleaks
fi

sha_var="GITLEAKS_SHA256_${os}_${arch}"
expected=${!sha_var:-}
[ -n "$expected" ] || die "no checksum for ${os}_${arch} in $here/pin.env ($sha_var); refusing to install unchecked"

target="$dir/$exe"
if [ -x "$target" ]; then
    installed=$("$target" version 2>/dev/null || true)
    if [ "${installed#v}" = "$GITLEAKS_VERSION" ]; then
        echo "gitleaks $GITLEAKS_VERSION is already installed at $target"
        exit 0
    fi
fi

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{ print $1 }'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{ print $1 }'
    else
        die "neither sha256sum nor shasum is available to check the download"
    fi
}

asset="gitleaks_${GITLEAKS_VERSION}_${os}_${arch}.${ext}"
url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${asset}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "gitleaks install: downloading $url"
if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$work/$asset" "$url" || die "download failed: $url"
elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$work/$asset" "$url" || die "download failed: $url"
else
    die "neither curl nor wget is available"
fi

actual=$(sha256_of "$work/$asset")
if [ "$actual" != "$expected" ]; then
    die "checksum mismatch for $asset: expected $expected, got $actual; refusing to install"
fi

mkdir -p "$work/extract"
if [ "$ext" = zip ]; then
    command -v unzip >/dev/null 2>&1 || die "unzip is needed to unpack $asset"
    unzip -q -o "$work/$asset" "$exe" -d "$work/extract" || die "$asset has no $exe"
else
    tar -xzf "$work/$asset" -C "$work/extract" "$exe" || die "$asset has no $exe"
fi

chmod 0755 "$work/extract/$exe"
unpacked=$("$work/extract/$exe" version 2>/dev/null || true)
if [ "${unpacked#v}" != "$GITLEAKS_VERSION" ]; then
    die "$asset holds a gitleaks reporting version '${unpacked}', expected $GITLEAKS_VERSION; refusing to install"
fi

mkdir -p "$dir"
# Copy then rename, so a running scan never sees a half-written binary.
cp "$work/extract/$exe" "$target.tmp.$$"
chmod 0755 "$target.tmp.$$"
mv -f "$target.tmp.$$" "$target"
echo "gitleaks $GITLEAKS_VERSION installed at $target"
case ":$PATH:" in
    *":$dir:"*) ;;
    *) echo "gitleaks install: note: $dir is not on PATH" >&2 ;;
esac
