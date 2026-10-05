## Purpose

Define the Node.js runtime baseline for the application: the minimum supported Node.js version, the Node.js base image used by the Docker build, and the matching `@types/node` type definitions so the runtime and TypeScript compilation targets stay aligned.

## Requirements

### Requirement: Node.js version compatibility
The system SHALL run on Node.js version 24.0.0 or higher.

#### Scenario: Application starts on Node.js 24
- **WHEN** the application is started with Node.js 24.0.0 or higher
- **THEN** the application starts successfully without errors

#### Scenario: Application fails on unsupported Node.js version
- **WHEN** the application is started with Node.js version lower than 24.0.0
- **THEN** the application may fail to start or exhibit unexpected behavior

### Requirement: Docker image uses Node.js 24
The Docker image SHALL be based on a Node.js 24 base image.

#### Scenario: Docker build succeeds
- **WHEN** the Docker image is built
- **THEN** the image is based on `node:24-alpine`

### Requirement: Type definitions match runtime version
The `@types/node` package version SHALL be compatible with Node.js 24.

#### Scenario: TypeScript compilation succeeds
- **WHEN** TypeScript compilation is run
- **THEN** no type errors related to Node.js API incompatibilities occur
