import { defineConfig, Plugin } from 'vite';
import { resolve } from 'path';

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
      const mod = server.moduleGraph.getModuleById(resolvedId);
      if (mod) {
        server.moduleGraph.invalidateModule(mod);
        return [...modules, mod];
      }
    }
  };
}

export default defineConfig({
  plugins: [buildTimePlugin()],
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
