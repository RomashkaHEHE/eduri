import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = join(PROJECT_ROOT, "node_modules");
const PUBLIC_VENDOR_ROOT = join(PROJECT_ROOT, "public", "vendor");

const PYODIDE_VERSION = "0.27.5";
const MONACO_VERSION = "0.55.1";
const PYODIDE_FILES = [
  "pyodide.js",
  "pyodide.asm.js",
  "pyodide.asm.wasm",
  "pyodide-lock.json",
  "python_stdlib.zip",
];

async function packageVersion(packageName) {
  const packageJsonPath = join(NODE_MODULES, packageName, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  return packageJson.version;
}

async function requireVersion(packageName, expectedVersion) {
  const installedVersion = await packageVersion(packageName);
  if (installedVersion !== expectedVersion) {
    throw new Error(
      `${packageName} ${expectedVersion} is required, found ${installedVersion}`,
    );
  }
}

function assertVendorTarget(target) {
  const pathFromVendorRoot = relative(PUBLIC_VENDOR_ROOT, target);
  if (
    pathFromVendorRoot === ""
    || pathFromVendorRoot.startsWith("..")
    || resolve(PUBLIC_VENDOR_ROOT, pathFromVendorRoot) !== resolve(target)
  ) {
    throw new Error(`Refusing to replace an invalid vendor target: ${target}`);
  }
}

async function requireFile(path) {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`Required runtime asset is missing: ${path}`);
}

async function replaceDirectory(target, copyAssets) {
  assertVendorTarget(target);
  await rm(target, { force: true, recursive: true });
  await mkdir(target, { recursive: true });
  await copyAssets(target);
}

await Promise.all([
  requireVersion("pyodide", PYODIDE_VERSION),
  requireVersion("monaco-editor", MONACO_VERSION),
]);

const pyodideSource = join(NODE_MODULES, "pyodide");
await Promise.all(PYODIDE_FILES.map((fileName) =>
  requireFile(join(pyodideSource, fileName))));

const monacoSource = join(NODE_MODULES, "monaco-editor", "min", "vs");
if (!(await stat(monacoSource)).isDirectory()) {
  throw new Error(`Required Monaco assets are missing: ${monacoSource}`);
}

await mkdir(PUBLIC_VENDOR_ROOT, { recursive: true });
await Promise.all([
  replaceDirectory(
    join(PUBLIC_VENDOR_ROOT, "pyodide", PYODIDE_VERSION),
    async (target) => {
      await Promise.all(PYODIDE_FILES.map((fileName) =>
        cp(join(pyodideSource, fileName), join(target, fileName))));
    },
  ),
  replaceDirectory(
    join(PUBLIC_VENDOR_ROOT, "monaco-editor", MONACO_VERSION, "vs"),
    (target) => cp(monacoSource, target, { recursive: true }),
  ),
]);
