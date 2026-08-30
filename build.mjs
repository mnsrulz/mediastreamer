import * as esbuild from 'esbuild'
import esbuildPluginPino from 'esbuild-plugin-pino';

await esbuild.build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  outdir: 'dist',
  format: 'esm',
  target: 'esnext',
  platform: 'node',
  packages: 'external',
  plugins: [
    esbuildPluginPino({
      transports: ['pino-pretty', '@logtail/pino']
    })
  ],
  // banner: { 
  //   js: `
  //     import { fileURLToPath } from 'node:url';
  //     import { dirname } from 'node:path';
  //     const __filename = fileURLToPath(import.meta.url);
  //     const __dirname = dirname(__filename);
  //   ` 
  // }
})