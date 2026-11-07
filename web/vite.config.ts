import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*",
  "img-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

function localHeaders(): Plugin {
  const apply = (server: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (name: string, value: string) => void }, next: () => void) => void) => void } }) => {
    server.middlewares.use((_req, res, next) => {
      res.setHeader("Content-Security-Policy", csp);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      next();
    });
  };
  return { name: "fabric-headers", configureServer: apply, configurePreviewServer: apply };
}

export default defineConfig({
  plugins: [react(), localHeaders()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: { allow: [path.resolve(import.meta.dirname, "..")] },
  },
  preview: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { target: "es2022", assetsInlineLimit: 0, sourcemap: false },
  optimizeDeps: { exclude: ["@matrix-org/matrix-sdk-crypto-wasm", "matrix-js-sdk"] },
  assetsInclude: ["**/*.wasm"],
});
