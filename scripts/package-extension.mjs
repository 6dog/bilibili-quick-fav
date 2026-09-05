import { createWriteStream } from "node:fs";
import { readdir, readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(projectRoot, "dist", "extension");
const releaseRoot = path.join(projectRoot, "dist", "release");
const zipPath = path.join(releaseRoot, "bilibili-quick-fav-2.0.1.zip");
const fixedDate = new Date("2020-01-01T00:00:00.000Z");

async function collectFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(absolute, relative)));
    else files.push({ absolute, relative });
  }
  return files;
}

await mkdir(releaseRoot, { recursive: true });
await rm(zipPath, { force: true });

const output = createWriteStream(zipPath);
const archive = archiver("zip", { zlib: { level: 9 } });
const completed = new Promise((resolve, reject) => {
  output.on("close", resolve);
  output.on("error", reject);
  archive.on("error", reject);
});
archive.pipe(output);
for (const file of await collectFiles(extensionRoot)) {
  archive.append(await readFile(file.absolute), { name: file.relative, date: fixedDate, mode: 0o644 });
}
await archive.finalize();
await completed;
console.log(`Packaged ${zipPath}`);
