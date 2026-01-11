import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const srcDir = path.join(rootDir, "src");
const distDir = path.join(rootDir, "dist");

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyFile(relativePath) {
  const sourcePath = path.join(srcDir, relativePath);
  const ext = path.extname(relativePath);

  if (ext === ".ts" || ext === ".d.ts") {
    return;
  }

  if (ext === ".js") {
    const tsPath = path.join(srcDir, relativePath.replace(/\.js$/, ".ts"));
    if (await exists(tsPath)) {
      return;
    }
  }

  const destPath = path.join(distDir, relativePath);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.copyFile(sourcePath, destPath);
}

async function walkDir(currentDir, relativeBase = "") {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(relativeBase, entry.name);
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walkDir(fullPath, relativePath);
        return;
      }

      if (entry.isFile()) {
        await copyFile(relativePath);
      }
    })
  );
}

await fs.mkdir(distDir, { recursive: true });
await walkDir(srcDir);
