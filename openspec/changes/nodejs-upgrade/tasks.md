## 1. Update Node.js Version Configuration

- [ ] 1.1 Update `engines.node` in `package.json` from `>=20.0.0` to `>=22.0.0`
- [ ] 1.2 Update `@types/node` devDependency from `^20.19.11` to `^22.0.0`

## 2. Update Docker Configuration

- [ ] 2.1 Update builder stage base image in Dockerfile from `node:20` to `node:22`
- [ ] 2.2 Update runtime stage base image in Dockerfile from `node:20-alpine` to `node:22-alpine`

## 3. Validate Dependencies

- [ ] 3.1 Run `npm install` to update lockfile with new type definitions
- [ ] 3.2 Verify all dependencies install without errors on Node.js 22

## 4. Test and Verify

- [ ] 4.1 Run full test suite (`npm test`) to verify compatibility
- [ ] 4.2 Run TypeScript compilation (`npm run build:tsc`) to verify type definitions
- [ ] 4.3 Run build (`npm run build`) to verify production build works
- [ ] 4.4 Test Docker build succeeds with updated images

## 5. Final Validation

- [ ] 5.1 Verify application starts correctly with `npm start`
- [ ] 5.2 Check for any deprecation warnings in console output
