import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'path';
import { execSync } from 'child_process';
import fs from 'fs';

function getVersion(): string {
  if (process.env.VERSION) {
    return process.env.VERSION;
  }

  try {
    const gitTag = execSync(
      'git describe --tags --exact-match 2>/dev/null || git describe --tags 2>/dev/null || echo ""',
      { encoding: 'utf8' }
    ).trim();
    if (gitTag) {
      return gitTag;
    }
  } catch {
    // Git not available or no tags
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));
    if (pkg.version && pkg.version !== '0.0.0') {
      return pkg.version;
    }
  } catch {
    // package.json not readable
  }

  return 'dev';
}

const APP_VERSION = getVersion();

// Vite's `define` only substitutes identifiers inside JS/TS source, not inside
// index.html. We hook the index pipeline so the inlined meta tag carries the
// build version too, then the runtime can read it from DOM for cache-busting.
const injectAppVersionIntoHtml = () => ({
  name: 'inject-app-version',
  transformIndexHtml: {
    order: 'pre' as const,
    handler(html: string) {
      return html.replaceAll('__APP_VERSION__', APP_VERSION);
    },
  },
});

export default defineConfig({
  plugins: [
    injectAppVersionIntoHtml(),
    react(),
    viteSingleFile({
      removeViteModuleLoader: true
    })
  ],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION)
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  css: {
    modules: {
      localsConvention: 'camelCase',
      generateScopedName: '[name]__[local]___[hash:base64:5]'
    },
    preprocessorOptions: {
      scss: {
        additionalData: `@use "@/styles/variables.scss" as *;`
      }
    }
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    rolldownOptions: {
      output: {
        codeSplitting: false
      }
    }
  }
});