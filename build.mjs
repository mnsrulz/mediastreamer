import * as esbuild from 'esbuild'
import esbuildPluginPino from 'esbuild-plugin-pino';

await esbuild.build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  outdir: 'dist',
  format: 'esm',
  target: 'esnext',
  platform: 'node',
  plugins: [esbuildPluginPino({ transports: ['pino-pretty'] })],
  banner: { js: 'import { createRequire } from "module";const require = createRequire(import.meta.url);' }
})