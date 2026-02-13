import { defineConfig, Plugin } from 'vite';
import { resolve } from 'path';
import { existsSync } from 'fs';

// ── HMR freeze: shared state between plugins ────────────────────────────

const FREEZE_PATH = resolve(__dirname, '.hmr-freeze');
let hmrFrozen = false;

function hmrFreezePlugin(): Plugin {
  let hasSuppressed = false;

  return {
    name: 'hmr-freeze',
    enforce: 'pre',
    configureServer(server) {
      hmrFrozen = existsSync(FREEZE_PATH);
      if (hmrFrozen) console.log('\x1b[36m[hmr-freeze]\x1b[0m Starting frozen — HMR paused');

      // Resolve the right send channel (Vite 6 = server.hot, Vite 5 = server.ws)
      const ws = server.hot ?? (server as any).ws;

      const check = () => {
        const exists = existsSync(FREEZE_PATH);
        if (exists && !hmrFrozen) {
          hmrFrozen = true;
          hasSuppressed = false;
          try { ws.send('hmr-freeze', {}); } catch { /* client not connected */ }
          console.log('\x1b[36m[hmr-freeze]\x1b[0m Frozen — HMR paused');
        } else if (!exists && hmrFrozen) {
          hmrFrozen = false;
          console.log(`\x1b[36m[hmr-freeze]\x1b[0m Thawed — ${hasSuppressed ? 'reloading' : 'no changes'}`);
          try { ws.send('hmr-thaw', {}); } catch { /* */ }
          if (hasSuppressed) {
            setTimeout(() => {
              try { ws.send({ type: 'full-reload', path: '*' }); } catch { /* */ }
            }, 50);
          }
          hasSuppressed = false;
        }
      };

      const timer = setInterval(check, 300);
      server.httpServer?.on('close', () => clearInterval(timer));
    },
    handleHotUpdate() {
      if (hmrFrozen) {
        hasSuppressed = true;
        return [];
      }
    },
  };
}

// ── Build time virtual module ───────────────────────────────────────────

function buildTimePlugin(): Plugin {
  const virtualId = 'virtual:buildtime';
  const resolvedId = '\0' + virtualId;
  return {
    name: 'build-time',
    resolveId(id) {
      if (id === virtualId) return resolvedId;
    },
    load(id) {
      if (id === resolvedId) {
        return `export default ${JSON.stringify(new Date().toLocaleTimeString())};`;
      }
    },
    handleHotUpdate({ server, modules }) {
      if (hmrFrozen) return []; // respect freeze
      const mod = server.moduleGraph.getModuleById(resolvedId);
      if (mod) {
        server.moduleGraph.invalidateModule(mod);
        return [...modules, mod];
      }
    }
  };
}

export default defineConfig({
  plugins: [hmrFreezePlugin(), buildTimePlugin()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    headers: {
      // Required for SharedArrayBuffer (AudioWorklet ring buffer)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
