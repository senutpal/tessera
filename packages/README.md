# Packages Architecture: Deep Modules

Every package in `packages/` is designed as a **deep module**: providing substantial functionality behind a small, cohesive interface.

## Package Layout Convention

```text
packages/<name>/
  index.ts        # Primary root entry point (public interface)
  client.ts       # Secondary entry point if needed (public interface)
  lib/            # Private internal implementation (hidden from outside callers)
  tests/          # Co-located tests exercising only the root entry points
  package.json    # Package manifest
  tsconfig.json   # TypeScript configuration
```

## Boundary Rules

1. **Entry-Point Boundary**: Outside code (applications or other packages) may import only root entry points (`packages/<pkg>/index.ts`, `packages/<pkg>/client.ts`), never anything inside `lib/` or other subfolders.
2. **Intra-Package Freedom**: Files within a package may freely import from one another.
3. **Tests Through Entry Points**: Test files in `packages/<pkg>/tests/` must import exclusively from their package's public entry points (or external package entry points), never reaching directly into internal subfolders.
4. **No Circular Dependencies**: Circular dependencies between modules or packages are forbidden.

## No Barrel Files

Do not create giant barrel files that re-export entire directory trees. Expose explicit, minimal root entry points.

## Boundary Enforcement

Run the boundary linter:

```bash
pnpm run lint:boundaries
```
