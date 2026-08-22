import * as esbuild from 'esbuild'
import esbuildPluginPino from 'esbuild-plugin-pino';

await esbuild.build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  outdir: 'dist',
  format: 'esm',
  target: 'esnext',
  platform: 'node',
  plugins: [esbuildPluginPino({ transports: ['pino-pretty', '@logtail/pino'] })],
  banner: { js: 'import { createRequire } from "module";const require = createRequire(import.meta.url);import { fileURLToPath } from "url";const __filename = fileURLToPath(import.meta.url);const __dirname = new URL(".", import.meta.url).pathname;' }
})