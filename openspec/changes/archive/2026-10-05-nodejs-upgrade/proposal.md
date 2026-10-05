## Why

The project currently specifies Node.js `>=20.0.0` as the minimum version, with Docker images based on `node:20`. Node.js 22 is the current LTS release with active support, and Node.js 24 is approaching. Upgrading ensures access to performance improvements, security patches, and modern JavaScript features while maintaining compatibility with the ecosystem.

## What Changes

- Update minimum Node.js version requirement from `>=20.0.0` to `>=22.0.0`
- Update Dockerfile base images from `node:20` to `node:22`
- Update `@types/node` devDependency to match new minimum version
- Verify all dependencies are compatible with Node.js 22+

## Capabilities

### New Capabilities

_(none - this is an infrastructure/maintenance change)_

### Modified Capabilities

_(no spec-level behavior changes)_

## Impact

- **Dockerfile**: Base image versions change from `node:20` to `node:22`
- **package.json**: `engines.node` field updated, `@types/node` version bumped
- **Dependencies**: May require updates if any have dropped Node.js 20 support
- **CI/CD**: If Node.js version is pinned in pipelines, those must be updated
- **Runtime**: Access to Node.js 22 features (import.meta.dirname, improved fetch, etc.)
