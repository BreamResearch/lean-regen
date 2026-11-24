# Source distribution and dependencies

| Component | Distribution and attribution |
| --- | --- |
| Lean Regen and Lean Verified SDLC 1.0.0 | Original project materials under Apache-2.0. The complete terms are in [LICENSE](LICENSE) and the original project attribution is in [NOTICE](NOTICE). [The provenance index](UPSTREAM_PROVENANCE.json) identifies all 68 files in the historical snapshot. |
| Lean 4.19.0, Lake and bundled Std | Downloaded separately for the inventory demo. The source ZIP contains the example's imports, lockfile and evidence. Consult the [upstream release](https://github.com/leanprover/lean4/releases/tag/v4.19.0), [license](https://github.com/leanprover/lean4/blob/v4.19.0/LICENSE) and the distribution's component notices when redistributing a toolchain. |
| GitHub Actions checkout | CI retrieves the pinned action from [its MIT-licensed repository](https://github.com/actions/checkout/blob/3d3c42e5aac5ba805825da76410c181273ba90b1/LICENSE). The action and hosted runner image are external build dependencies. |
| Python and OpenSSL | Supplied by the user's machine or runner. Python runs the CLI and OpenSSL is used by the historical signature transport tests. Their binaries are outside the source distribution. |

The inventory demo has no external Lake package dependencies. Links to research, vendor documentation and products identify their respective publishers.

## Lean toolchain and project name

The Lean proof assistant uses Apache-2.0 in both the historical compiler and the newer compiler selected for the experimental checker. Its binary distributions carry additional terms, including LLVM's Apache-2.0 with LLVM exceptions and GNU MP's LGPLv3. The source-alpha assets contain project sources and evidence. For a future binary or container distribution, identify the libraries actually bundled or linked, retain applicable notices and meet the corresponding distribution and relinking requirements. [4.19.0 component licenses](https://github.com/leanprover/lean4/blob/v4.19.0/LICENSES) · [4.36.0 license](https://github.com/leanprover/lean4/blob/v4.36.0/LICENSE) · [4.36.0 component licenses](https://github.com/leanprover/lean4/blob/v4.36.0/LICENSES).

Inspection of the locally built macOS inventory executable found GNU MP symbols in the binary. That executable is outside the source archive. The local development build retains the toolchain notices alongside its executables.

BreamResearch uses the repository name `lean-regen` to identify compatibility with the Lean proof assistant. This independent project uses no official logo. Lean FRO's policy permits descriptive repository and package names under its non-affiliation conditions. Incorporating a Lean trademark into another trademark requires written permission. A commercial service brand has yet to be selected. [Lean FRO trademark policy](https://lean-lang.org/trademark-policy/).
