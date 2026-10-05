## 1. Update Node.js Version Configuration

- [x] 1.1 Update `engines.node` in `package.json` from `>=20.0.0` to `>=22.0.0`
- [x] 1.2 Update `@types/node` devDependency from `^20.19.11` to `^22.0.0`

## 2. Update Docker Configuration

- [x] 2.1 Update builder stage base image in Dockerfile from `node:20` to `node:22`
- [x] 2.2 Update runtime stage base image in Dockerfile from `node:20-alpine` to `node:22-alpine`

## 3. Validate Dependencies

- [x] 3.1 Run `npm install` to update lockfile with new type definitions
- [x] 3.2 Verify all dependencies install without errors on Node.js 22

## 4. Test and Verify

- [x] 4.1 Run full test suite (`npm test`) to verify compatibility
- [x] 4.2 Run TypeScript compilation (`npm run build:tsc`) to verify type definitions
- [x] 4.3 Run build (`npm run build`) to verify production build works
- [x] 4.4 Test Docker build succeeds with updated images

## 5. Final Validation

- [x] 5.1 Verify application starts correctly with `npm start`
- [x] 5.2 Check for any deprecation warnings in console output

## Verification note (2026-10-05)

Target superseded from Node 22 to **Node 24** (commits `8191854` bump to node22, `ae53e46` bump node to 24): `.nvmrc`=24, `engines.node`=`>=24.0.0`, `@types/node`^24 (lock 24.13.3), Dockerfile single-stage `node:24-alpine` (the builder stage was removed, so tasks 2.1/2.2 are satisfied by the single runtime image). Verified: `npm install` clean, `tsc` clean, 23/23 tests green (run via `node --import tsx --test test/*test.ts` — no `npm test` script exists), app starts and runs with no deprecation warnings. 4.4 verified via the GitHub Actions image build (ghcr.yml) running green on push; local Docker daemon was not running at verification time.
