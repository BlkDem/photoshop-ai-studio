import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';

/**
 * Studio dev server.
 *
 * Two proxies, both to keep the browser on a single origin:
 *
 *   /api -> the Orchestrator (REST + NDJSON event stream)
 *   /mcp -> the MCP server, so `npm run inspector` and manual `curl` debugging
 *          work through the same origin the UI uses. The UI itself does not
 *          speak MCP - the Orchestrator is the MCP client - but having the path
 *          available makes the MCP surface inspectable without a second port.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'STUDIO_');
  const studioPort = Number(env.STUDIO_PORT ?? 3000);
  const orchestratorPort = Number(process.env.ORCHESTRATOR_PORT ?? 3003);
  const mcpPort = Number(process.env.MCP_PORT ?? 3001);

  const proxy = (port: number): ProxyOptions => ({
    target: `http://127.0.0.1:${port}`,
    changeOrigin: false,
  });

  return {
    plugins: [react()],
    server: {
      port: studioPort,
      strictPort: false,
      // Vite binds loopback only by default, which on this machine means the
      // dev server is invisible from WSL — it reaches Windows over the vEthernet
      // gateway, not over 127.0.0.1. Bound to all interfaces the same URL works
      // from Windows and from WSL. The exposure is the host's own vEthernet
      // adapter rather than the LAN, and Vite prints the URLs either way.
      host: env.STUDIO_HOST || '0.0.0.0',
      proxy: {
        // No timeout: `/api/events` is a long-lived stream.
        '/api': { ...proxy(orchestratorPort), timeout: 0, proxyTimeout: 0 },
        '/mcp': proxy(mcpPort),
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      target: 'es2022',
    },
  };
});
