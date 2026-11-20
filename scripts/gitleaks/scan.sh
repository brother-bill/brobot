#!/usr/bin/env bash
#
# The one gitleaks entry point: the pre-commit hook, CI and the docs all call
# this, so every scan gets the same flags.
#
#   bash scripts/gitleaks/scan.sh staged             what `git commit` is about to record
#   bash scripts/gitleaks/scan.sh range <rev-range>  the commits in <rev-range>, e.g. origin/main..HEAD
#   bash scripts/gitleaks/scan.sh history            every commit reachable from HEAD, minus the baseline
#   bash scripts/gitleaks/scan.sh baseline           rewrite .gitleaks-baseline.json from origin/main
#
# Every scan is --redact --no-banner, uses .gitleaks.toml at the repository
# root when there is one (gitleaks' default rules otherwise), and refuses to
# run with any gitleaks but the version pinned in pin.env.
#
# Exit codes: 0 clean, 1 findings (or a .gitleaksignore, see below),
# 2 gitleaks missing or not the pinned version, 64 usage.
#
# GITLEAKS_BIN names the binary to use (default: `gitleaks` on PATH).
#
# Copied unchanged into every repository that runs gitleaks; keep it generic.

set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=pin.env
. "$here/pin.env"

usage() {
    echo "usage: scan.sh <staged|range <rev-range>|history|baseline>" >&2
    exit 64
}

mode=${1:-}
case "$mode" in
    staged | history | baseline) [ $# -eq 1 ] || usage ;;
    range) [ $# -eq 2 ] && [ -n "$2" ] || usage ;;
    *) usage ;;
esac

root=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "gitleaks scan: not inside a git repository" >&2
    exit 64
}
cd "$root" || exit 64

bin=${GITLEAKS_BIN:-gitleaks}
if ! command -v "$bin" >/dev/null 2>&1; then
    echo "gitleaks scan: gitleaks is not installed (want $GITLEAKS_VERSION): bash scripts/gitleaks/install.sh" >&2
    exit 2
fi
found=$("$bin" version 2>/dev/null || true)
found=${found#v}
if [ "$found" != "$GITLEAKS_VERSION" ]; then
    echo "gitleaks scan: gitleaks ${found:-of unknown version} is not the pinned $GITLEAKS_VERSION: bash scripts/gitleaks/install.sh" >&2
    exit 2
fi

# gitleaks reads a .gitleaksignore at the scanned root whatever its flags say,
# and every fingerprint in it is a finding nobody sees. The allowed exceptions
# are the reviewed ones: .gitleaks.toml, the baseline and `gitleaks:allow`.
if [ -e .gitleaksignore ]; then
    echo "gitleaks scan: .gitleaksignore is not allowed: it hides findings from review." >&2
    echo "  Mark a false positive with a gitleaks:allow comment on its line instead." >&2
    exit 1
fi

# Only the repository's own config or the default one: never a config an
# environment variable happens to point at.
unset GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML
args=(git --redact --no-banner)
if [ -f .gitleaks.toml ]; then
    args+=(--config .gitleaks.toml)
fi

baseline=.gitleaks-baseline.json

case "$mode" in
    staged)
        # GIT_INDEX_FILE, when git sets it (`commit -a`, `commit <path>`), is
        # the index this commit records, and `git diff --staged` reads it.
        exec "$bin" "${args[@]}" --exit-code 1 --pre-commit --staged .
        ;;
    range)
        exec "$bin" "${args[@]}" --exit-code 1 --log-opts="$2" .
        ;;
    history)
        if [ -f "$baseline" ]; then
            args+=(--baseline-path "$baseline")
        fi
        exec "$bin" "${args[@]}" --exit-code 1 --log-opts=HEAD .
        ;;
    baseline)
        if ! git rev-parse --verify -q origin/main^{commit} >/dev/null; then
            echo "gitleaks scan: origin/main is not available; git fetch origin main first" >&2
            exit 64
        fi
        tmp=$(mktemp "${TMPDIR:-/tmp}/gitleaks-baseline.XXXXXX")
        trap 'rm -f "$tmp"' EXIT
        # Findings are what a baseline is made of, so they are not a failure
        # here; anything else gitleaks exits non-zero for still is.
        "$bin" "${args[@]}" --exit-code 0 --log-opts=origin/main \
            --report-format json --report-path "$tmp" . || exit 1
        cat "$tmp" >"$baseline"
        count=$(grep -c '"Fingerprint":' "$baseline" || true)
        echo "gitleaks scan: wrote $baseline with ${count:-0} findings from origin/main" >&2
        ;;
esac
