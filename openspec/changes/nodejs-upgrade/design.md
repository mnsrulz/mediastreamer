## Context

The mediastreamer project currently targets Node.js 20 as the minimum version. The `package.json` specifies `engines.node: ">=20.0.0"` and the Dockerfile uses `node:20` base images. Node.js 22 is the current active LTS release (entering maintenance in October 2025), offering performance improvements, security patches, and modern JavaScript features. Node.js 24 is approaching initial release.

The project is a Fastify-based media streaming server with TypeScript, using ES modules. Dependencies include Fastify 4.x, Got 12.x, and various TypeScript tooling.

## Goals / Non-Goals

**Goals:**
- Update minimum Node.js version to 22.0.0
- Update Docker images to use Node.js 22
- Update `@types/node` to match the new minimum version
- Ensure all dependencies are compatible with Node.js 22
- Maintain backward compatibility for users currently on Node.js 20+

**Non-Goals:**
- Adopting new Node.js 22-specific APIs in application code (can be done incrementally later)
- Upgrading to Fastify 5.x or other major dependency versions
- Restructuring the build or deployment pipeline
- Adding Node.js version management tools (nvm, fnm, etc.)

## Decisions

### Decision: Minimum version `>=22.0.0` (not `>=20.0.0` maintained)

**Choice**: Set `engines.node` to `>=22.0.0`

**Rationale**: Node.js 20 reaches end-of-life in April 2026. Setting 22 as minimum aligns with the active LTS lifecycle and avoids supporting a version approaching EOL. Users on Node.js 20 can still run the application (it will work), but the project won't officially support or test against it.

**Alternatives considered**:
- `>=20.0.0` (no change): Rejected because it delays the inevitable and misses security/performance benefits
- `>=21.0.0`: Rejected because 21 is not an LTS release
- `>=24.0.0`: Rejected because 24 is not yet released/stable

### Decision: Docker base images `node:22` and `node:22-alpine`

**Choice**: Update both builder and runtime stages to `node:22`

**Rationale**: Matches the minimum version requirement. Alpine variant for runtime keeps image size small. The builder stage uses full image for native module compilation support.

**Alternatives considered**:
- `node:22-slim`: Considered but Alpine is already in use and well-tested
- Pinning to specific patch (e.g., `node:22.5.0`): Rejected to automatically receive patch updates

### Decision: Update `@types/node` to `^22.0.0`

**Choice**: Bump `@types/node` from `^20.19.11` to `^22.0.0`

**Rationale**: Type definitions should match the minimum supported runtime version to catch use of unavailable APIs at compile time.

### Decision: Dependency compatibility verification strategy

**Choice**: Run `npm install` and full test suite after version updates; fix any breakage

**Rationale**: Most modern npm packages support Node.js 22 without changes. Breaking issues are rare and specific to native modules or deprecated APIs. Testing is the most reliable way to identify problems.

**Alternatives considered**:
- Manual audit of each dependency: Rejected as time-consuming and error-prone
- Using `npm audit` only: Insufficient - doesn't catch runtime compatibility issues

## Risks / Trade-offs

- **[Risk] Native module incompatibility** → Mitigation: Test `npm install` on clean environment; check `npm rebuild` for any native addons
- **[Risk] Dependency version conflicts** → Mitigation: Run full test suite; update any incompatible dependencies
- **[Risk] CI/CD pipeline requires Node.js version update** → Mitigation: Check pipeline configs; update `.node-version` or equivalent if present
- **[Trade-off] Users on Node.js 20 lose official support** → Accepted: Node.js 20 EOL is April 2026; users have upgrade path
- **[Trade-off] Docker image size may change slightly** → Accepted: Minor difference between node:20 and node:22 base images

## Migration Plan

1. Update `package.json` engines and `@types/node`
2. Update Dockerfile base images
3. Run `npm install` to update lockfile
4. Run full test suite
5. Build and verify TypeScript compilation
6. Test Docker build
7. Deploy to staging environment for validation
8. Merge and deploy to production

**Rollback**: Revert the version changes in `package.json` and Dockerfile; redeploy previous Docker image.

## Open Questions

- Are there any CI/CD pipeline configurations that pin Node.js versions?
- Are there any deployment scripts or infrastructure configs that reference Node.js 20 specifically?
