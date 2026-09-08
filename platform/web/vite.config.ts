import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

export function precompressAssets(): Plugin {
  let serverBuild = false;
  return {
    name: "pylon-precompressed-assets",
    apply: "build",
    configResolved(config) { serverBuild = Boolean(config.build.ssr); },
    async writeBundle(options, bundle) {
      if (serverBuild) return;
      if (!options.dir) throw new Error("Asset compression requires an output directory");
      // Vite finalizes CSS and dynamic imports after user generateBundle hooks.
      // Compress the written bytes, one original at a time, rather than that earlier snapshot.
      for (const asset of Object.values(bundle)) {
        if (!/\.(?:js|css|svg)$/.test(asset.fileName)) continue;
        const file = resolve(options.dir, asset.fileName);
        const body = await readFile(file);
        const [br, gz] = body.byteLength < 1_024 ? [] : await Promise.all([
          compressBrotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }),
          compressGzip(body, { level: 9 }),
        ]);
        for (const [suffix, source] of [["br", br], ["gz", gz]] as const) {
          const variant = `${file}.${suffix}`;
          if (!source || source.byteLength >= body.byteLength) {
            await rm(variant, { force: true });
            continue;
          }
          const temporary = `${variant}.tmp-${process.pid}`;
          try {
            await writeFile(temporary, source);
            await rename(temporary, variant);
          } finally { await rm(temporary, { force: true }); }
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), precompressAssets()],
  worker: { format: "es" },
  resolve: {
    alias: [
      {
        find: /^@tabler\/icons-react$/,
        replacement: fileURLToPath(new URL("./src/client/ui/tabler-icons.mjs", import.meta.url)),
      },
    ],
  },
  build: { target: "es2022", cssCodeSplit: true, sourcemap: false },
});
