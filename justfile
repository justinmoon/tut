set positional-arguments

default:
    @just --list

run *args='--help':
    @bun src/main.ts "$@"

typecheck:
    @bunx tsc --noEmit

test:
    @bun test

check-package-scripts:
    @bun -e 'const pkg = await Bun.file("package.json").json(); if ("scripts" in pkg) { console.error("package.json must not define scripts; use justfile recipes instead."); process.exit(1); }'

check: check-package-scripts typecheck test

build-bin:
    @mkdir -p dist
    @bun build --compile ./src/main.ts --outfile ./dist/tut-aarch64-darwin

build-release: build-bin
    @gzip -9 -c ./dist/tut-aarch64-darwin > ./dist/tut-aarch64-darwin.gz
