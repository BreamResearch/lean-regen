#!/usr/bin/env sh
set -eu
if [ "$#" -ne 2 ]; then
    printf '%s\n' 'Usage: sh native/build_oracle.sh LEAN_BIN NEW_BUILD_DIRECTORY' >&2
    exit 2
fi
origin=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
lean_bin=$(CDPATH= cd -- "$1" && pwd)
export PATH="$lean_bin:$PATH"
build=$2
mkdir "$build"
cp -R "$origin/../../formal/Knot" "$build/Knot"
cp "$origin/../../formal/lean-toolchain" "$origin/../../formal/lakefile.toml" "$build/"
cp "$origin/WordOracle.lean" "$build/WordOracle.lean"
cd "$build"
cat >> lakefile.toml <<'TOML'

[[lean_exe]]
name = "wordOracle"
root = "WordOracle"
TOML
lake build wordOracle
printf '%s\n' 'import Knot.Machine' > WordAxioms.lean
for theorem in wideSum_exact failed_exact bit_exact ordered_violations accepted_exact no_reserved_bits scalar_ordered; do
    printf '#print axioms Knot.Machine.%s\n' "$theorem" >> WordAxioms.lean
done
lake env lean WordAxioms.lean > axioms.txt
for theorem in wideSum_exact failed_exact bit_exact ordered_violations accepted_exact no_reserved_bits scalar_ordered; do
    grep -F -x "'Knot.Machine.$theorem' depends on axioms: [propext, Quot.sound]" axioms.txt
done
