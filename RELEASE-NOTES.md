# Lean Regen source alpha

## v0.2.0-alpha.2

This source distribution contains the local CLI, Apache-2.0 terms, the unchanged 68-file Lean Verified SDLC 1.0.0 snapshot and its synthetic inventory example. Anyone with Python 3.11+ and Lean/Lake 4.19.0 can run it locally without signing up.

The attached `core-check.json` records ordinary Lean kernel checking of 14 named theorems on sequential reserve/release operations. The report binds the model, fixed contract, toolchain executables and checked build artifact. The native binary can be rebuilt locally. The source ZIP also contains the three semantic mutation logs. Independent verification, unattended promotion and real application behavior have separate acceptance criteria in `EXECUTION_PLAN.json`.

### Verify the assets

Download the source ZIP, `manifest.json`, `core-check.json`, `RELEASE-NOTES.md` and `SHA256SUMS` into one directory. Run `shasum -a 256 -c SHA256SUMS` (macOS) or `sha256sum -c SHA256SUMS` (Linux). The manifest identifies the Git commit and each source file. These local checksums identify bytes. The README in the ZIP gives the commands to rerun the demo with a trusted Lean installation.

A maintainer can recreate the same assets by checking out the manifest's commit and running `python3 scripts/build_source_alpha.py --out ../lean-regen-release` with a fresh output directory. The builder reads committed files and runs offline. It emits an unsigned source release candidate. Public availability and enabled services are recorded separately in `STATUS.json`.

The previous local candidate, v0.2.0-alpha.1, remains available in local Git history. This candidate also validates the complete release manifest, checks the GitHub tag binding again during publication, and fixes the release notes to the tagged source. The verified Lean model and contract remain at their original hashes.
