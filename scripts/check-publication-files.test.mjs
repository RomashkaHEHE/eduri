import assert from "node:assert/strict";
import test from "node:test";

import {
  publicationContentViolation,
  publicationPathViolation,
} from "./check-publication-files.mjs";

test("blocks private publication paths even when force-added", () => {
  for (const filePath of [
    ".env",
    ".env.production",
    ".qa-board-v2/eduri.sqlite-wal",
    "data/eduri.sqlite",
    "backups/release.tar.gz",
    "credentials/private.pem",
    "keys/id_ed25519",
    ".docker/config.json",
    ".direnv/allow/secret",
    ".authinfo.gpg",
    ".npmrc",
    ".pnpmrc",
    ".yarnrc",
    ".yarnrc.yml",
  ]) {
    assert.equal(typeof publicationPathViolation(filePath), "string", filePath);
  }
  assert.equal(publicationPathViolation(".env.example"), null);
  assert.equal(publicationPathViolation("src/server/db.ts"), null);
});

test("detects disguised database and private-key content", () => {
  assert.equal(
    publicationContentViolation(Buffer.from("SQLite format 3\0rest")),
    "SQLite database content",
  );
  assert.equal(
    publicationContentViolation(Buffer.from(["-----BEGIN ", "PRIVATE KEY-----\n"].join(""))),
    "private-key content",
  );
  assert.equal(
    publicationContentViolation(Buffer.from([
      "-----BEGIN ",
      "ENCRYPTED PRIVATE KEY-----\n",
    ].join(""))),
    "private-key content",
  );
  assert.equal(publicationContentViolation(Buffer.from("ordinary source")), null);
});
