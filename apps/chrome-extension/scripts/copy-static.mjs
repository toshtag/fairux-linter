import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Copy manifest.json + popup.html into dist/ so the folder is a loadable unpacked extension.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = resolve(root, "dist");

await mkdir(dist, { recursive: true });
for (const file of ["manifest.json", "popup.html"]) {
  await cp(resolve(root, "static", file), resolve(dist, file));
}
console.log("copied static assets → dist/");
