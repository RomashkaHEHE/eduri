import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FORBIDDEN_ROOTS = [
  ".qa-board-v2/",
  "backups/",
  "data/",
  "data-dev/",
];
const FORBIDDEN_BASENAMES = new Set([
  ".authinfo",
  ".authinfo.gpg",
  ".envrc",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pnpmrc",
  ".pypirc",
  ".yarnrc",
  ".yarnrc.yml",
]);
const FORBIDDEN_DATABASE_SUFFIX = /(?:^|\.)(?:sqlite3?|db)(?:-(?:shm|wal|journal))?$/iu;
const FORBIDDEN_SECRET_SUFFIX = /(?:^|\.)(?:shm|wal|p12|pfx|p8|pk8|ppk|jks|keystore|pem|key)$/iu;
const FORBIDDEN_ARCHIVE_SUFFIX = /(?:^|\.)(?:tar(?:\.(?:gz|bz2|xz|zst))?|tgz|zip|7z|rar|gz|bz2|xz|bak|backup)$/iu;
const PRIVATE_KEY_HEADER = new RegExp([
  "-----BEGIN ",
  "(?:ENCRYPTED |OPENSSH |RSA |EC |DSA )?",
  "PRIVATE KEY-----",
  "|---- BEGIN SSH2 ",
  "ENCRYPTED PRIVATE KEY ----",
].join(""), "u");
const PRIVATE_SSH_KEY_BASENAME = /^id_(?:dsa|ecdsa|ed25519|rsa)$/u;

function normalizedPath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function publicationPathViolation(filePath) {
  const normalized = normalizedPath(filePath);
  const lower = normalized.toLowerCase();
  if (FORBIDDEN_ROOTS.some((root) => lower.startsWith(root))) {
    return "private data directory";
  }
  if (/^qa-data-[^/]*(?:\/|$)/u.test(lower)) return "QA data directory";
  const basename = path.posix.basename(lower);
  if (lower === ".docker/config.json" || lower.startsWith(".direnv/")) {
    return "credential configuration file";
  }
  if (basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example")) {
    return "environment secret file";
  }
  if (
    FORBIDDEN_BASENAMES.has(basename)
    || basename.startsWith(".envrc.")
    || PRIVATE_SSH_KEY_BASENAME.test(basename)
  ) return "credential configuration file";
  if (
    FORBIDDEN_DATABASE_SUFFIX.test(basename)
    || FORBIDDEN_SECRET_SUFFIX.test(basename)
    || FORBIDDEN_ARCHIVE_SUFFIX.test(basename)
  ) return "database, archive, or private-key file";
  return null;
}

export function publicationContentViolation(prefix) {
  if (prefix.subarray(0, 16).toString("utf8") === "SQLite format 3\0") {
    return "SQLite database content";
  }
  if (PRIVATE_KEY_HEADER.test(prefix.toString("utf8"))) {
    return "private-key content";
  }
  return null;
}

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.split("\0").filter(Boolean);
}

export function checkTrackedPublication(root = process.cwd()) {
  const violations = [];
  for (const trackedPath of trackedFiles()) {
    const pathViolation = publicationPathViolation(trackedPath);
    if (pathViolation) {
      violations.push({ path: trackedPath, reason: pathViolation });
      continue;
    }
    const absolute = path.resolve(root, trackedPath);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile()) continue;
    const handle = fs.openSync(absolute, "r");
    try {
      const prefix = Buffer.alloc(Math.min(4_096, stat.size));
      fs.readSync(handle, prefix, 0, prefix.length, 0);
      const contentViolation = publicationContentViolation(prefix);
      if (contentViolation) {
        violations.push({ path: trackedPath, reason: contentViolation });
      }
    } finally {
      fs.closeSync(handle);
    }
  }
  return violations;
}

function isEntrypoint() {
  return Boolean(process.argv[1])
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isEntrypoint()) {
  let violations;
  try {
    violations = checkTrackedPublication();
  } catch (error) {
    console.error("Publication manifest check requires a Git worktree.");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
  if (violations?.length) {
    console.error("Refusing to publish forbidden tracked files:");
    for (const violation of violations) {
      console.error(`- ${violation.path}: ${violation.reason}`);
    }
    process.exitCode = 1;
  } else if (violations) {
    console.log("Publication manifest contains no forbidden private files.");
  }
}
