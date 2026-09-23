import { defineConfig } from "tsup";

export default defineConfig({
  // index.ts = Node/stdio CLI (keeps its own shebang, see src/index.ts).
  // server.ts = runtime-agnostic library entry (Cloudflare Workers etc.).
  entry: ["src/index.ts", "src/server.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  dts: true,
});
