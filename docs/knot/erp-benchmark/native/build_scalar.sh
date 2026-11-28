#!/bin/sh
# Build the compiler-emitted Knot scalar. Keep one exported function from the full Lean C module.
set -eu
export LC_ALL=C

if [ "$#" -ne 3 ]; then
    echo "Usage: build_scalar.sh LEAN_BIN ORACLE_BUILD OUT" >&2
    exit 2
fi
lean_bin=$1
oracle_build=$2
output=$3
case "$lean_bin" in
    */lean) lean_bin=$(dirname "$lean_bin") ;;
esac
case "$("$lean_bin/lean" --version)" in
    "Lean (version 4.19.0,"*) ;;
    *) echo "Expected the pinned Lean 4.19.0 toolchain" >&2; exit 2 ;;
esac
include_dir=$(cd "$lean_bin/../include" && pwd)
module=$oracle_build/ir/Knot/Machine.c
if [ ! -f "$module" ]; then
    module=$oracle_build/.lake/build/ir/Knot/Machine.c
fi
if [ ! -f "$module" ] || [ ! -f "$include_dir/lean/lean.h" ]; then
    echo "Build wordOracle with Lake first and provide its build directory or project root" >&2
    exit 2
fi
if [ -e "$output" ] || [ -L "$output" ]; then
    echo "Choose an unused output path" >&2
    exit 2
fi
out_dir=$(dirname "$output")
mkdir -p "$out_dir"
scratch=$(mktemp -d "$out_dir/.knot-word-XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
trap 'exit 1' HUP INT TERM
cc=${CC:-cc}
library=$scratch/library

case "$(uname -s)" in
    Darwin)
        "$cc" -O3 -DNDEBUG -fPIC -ffunction-sections -fdata-sections -dynamiclib \
            -Wl,-dead_strip -Wl,-exported_symbol,_knot_word_mask \
            -Wl,-install_name,@rpath/libknot_word.dylib \
            -I "$include_dir" "$module" -o "$library"
        definitions=$(nm -gU "$library" | awk '{print $NF}')
        imports=$(nm -u "$library")
        required=_knot_word_mask
        ;;
    Linux)
        printf '%s\n' '{ global: knot_word_mask; local: *; };' > "$scratch/exports.map"
        "$cc" -O3 -DNDEBUG -fPIC -ffunction-sections -fdata-sections -shared -nostdlib \
            -Wl,--gc-sections -Wl,-z,defs -Xlinker --version-script -Xlinker "$scratch/exports.map" \
            -Wl,-soname,libknot_word.so -I "$include_dir" "$module" -o "$library"
        definitions=$(nm -D --defined-only --extern-only "$library" | awk '{print $NF}')
        imports=$(nm -D --undefined-only "$library")
        required=knot_word_mask
        dynamic=$(readelf -d "$library")
        case "$dynamic" in
            *"(NEEDED)"*) echo "Unexpected dynamic dependency in the ELF scalar" >&2; exit 1 ;;
        esac
        ;;
    *) echo "Use a Darwin or Linux build host" >&2; exit 2 ;;
esac
if [ "$definitions" != "$required" ] || [ -n "$imports" ]; then
    echo "Unexpected exported or unresolved symbols in the scalar library" >&2
    exit 1
fi
# link(2) publishes the audited bytes atomically and refuses an existing destination.
ln "$library" "$output"
