## ADDED Requirements

### Requirement: Node.js version compatibility
The system SHALL run on Node.js version 22.0.0 or higher.

#### Scenario: Application starts on Node.js 22
- **WHEN** the application is started with Node.js 22.0.0 or higher
- **THEN** the application starts successfully without errors

#### Scenario: Application fails on unsupported Node.js version
- **WHEN** the application is started with Node.js version lower than 22.0.0
- **THEN** the application may fail to start or exhibit unexpected behavior

### Requirement: Docker image uses Node.js 22
The Docker images SHALL be based on Node.js 22 base images.

#### Scenario: Docker build succeeds
- **WHEN** the Docker image is built
- **THEN** the image is based on `node:22` (builder) and `node:22-alpine` (runtime)

### Requirement: Type definitions match runtime version
The `@types/node` package version SHALL be compatible with Node.js 22.

#### Scenario: TypeScript compilation succeeds
- **WHEN** TypeScript compilation is run
- **THEN** no type errors related to Node.js API incompatibilities occur
