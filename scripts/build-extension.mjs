import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import sharp from "sharp";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "dist", "extension");
const packageVersion = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")).version;
const manifest = JSON.parse(await readFile(path.join(projectRoot, "extension", "manifest.json"), "utf8"));
const typesSource = await readFile(path.join(projectRoot, "src", "shared", "types.ts"), "utf8");
if (manifest.version !== packageVersion || !typesSource.includes(`EXTENSION_VERSION = "${packageVersion}"`)) {
  throw new Error("package.json, manifest and runtime version must match");
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(outputRoot, "popup"), { recursive: true });
await mkdir(path.join(outputRoot, "icons"), { recursive: true });

await build({
  entryPoints: [path.join(projectRoot, "src", "content", "main.ts")],
  outfile: path.join(outputRoot, "content.js"),
  bundle: true,
  format: "iife",
  target: "chrome120",
  minify: false,
  legalComments: "none",
});

await build({
  entryPoints: [path.join(projectRoot, "src", "popup", "main.ts")],
  outfile: path.join(outputRoot, "popup", "popup.js"),
  bundle: true,
  format: "iife",
  target: "chrome120",
  minify: false,
  legalComments: "none",
});

await cp(path.join(projectRoot, "extension", "manifest.json"), path.join(outputRoot, "manifest.json"));
await cp(path.join(projectRoot, "src", "popup", "index.html"), path.join(outputRoot, "popup", "index.html"));
await cp(path.join(projectRoot, "src", "popup", "popup.css"), path.join(outputRoot, "popup", "popup.css"));

const iconSvg = await readFile(path.join(projectRoot, "assets", "icon.svg"));
for (const size of [16, 32, 48, 128]) {
  await sharp(iconSvg).resize(size, size).png().toFile(path.join(outputRoot, "icons", `icon-${size}.png`));
}

const promoSvg = await readFile(path.join(projectRoot, "assets", "store-promo.svg"));
await mkdir(path.join(projectRoot, "dist", "store-assets"), { recursive: true });
await sharp(promoSvg).png().toFile(path.join(projectRoot, "dist", "store-assets", "small-promo-440x280.png"));
await cp(path.join(projectRoot, "assets", "store-screenshot.png"), path.join(projectRoot, "dist", "store-assets", "screenshot-1280x800.png"));
await cp(path.join(projectRoot, "assets", "store-cover.png"), path.join(projectRoot, "dist", "store-assets", "cover-1280x800.png"));
await cp(path.join(projectRoot, "assets", "store-picker.png"), path.join(projectRoot, "dist", "store-assets", "picker-1280x800.png"));
await writeFile(path.join(outputRoot, "BUILD_VERSION"), `${packageVersion}\n`, "utf8");

console.log(`Built extension at ${outputRoot}`);
