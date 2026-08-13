#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import io
import os
from pathlib import Path
import re
import tarfile
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("validate_cd_release.py")
SPEC = importlib.util.spec_from_file_location("validate_cd_release", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


def required_entries() -> dict[str, bytes]:
    return {path: b"test\n" for path in VALIDATOR.REQUIRED_FILES}


def write_archive(
    path: Path,
    entries: dict[str, bytes],
    *,
    special: tuple[str, bytes, bytes] | None = None,
) -> None:
    with tarfile.open(path, "w:gz") as archive:
        for name, content in entries.items():
            member = tarfile.TarInfo(name)
            member.size = len(content)
            member.mode = 0o755 if name.endswith(".sh") else 0o644
            archive.addfile(member, io.BytesIO(content))
        if special:
            name, member_type, link_name = special
            member = tarfile.TarInfo(name)
            member.type = member_type
            member.linkname = link_name.decode()
            archive.addfile(member)


class ReleaseValidatorTests(unittest.TestCase):
    def validate(self, entries: dict[str, bytes], **kwargs: object) -> Path:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        archive = root / "release.tar.gz"
        destination = root / "release"
        write_archive(archive, entries, **kwargs)
        VALIDATOR.validate_and_extract(archive, destination)
        return destination

    def test_extracts_a_valid_release_without_loosening_modes(self) -> None:
        entries = required_entries()
        entries["src/index.ts"] = b"export {};\n"
        destination = self.validate(entries)
        self.assertEqual((destination / "src/index.ts").read_bytes(), b"export {};\n")
        if os.name != "nt":
            self.assertEqual(
                (destination / "ops/scripts/deploy.sh").stat().st_mode & 0o777,
                0o755,
            )
            self.assertEqual(
                (destination / "src/index.ts").stat().st_mode & 0o777,
                0o644,
            )

    def test_rejects_traversal_and_protected_paths(self) -> None:
        for unsafe in (
            "../escape",
            "/absolute",
            "data/eduri.sqlite",
            ".env",
            ".env.production",
            "nested/secret.pem",
        ):
            with self.subTest(path=unsafe):
                entries = required_entries()
                entries[unsafe] = b"private"
                with self.assertRaises(VALIDATOR.ReleaseValidationError):
                    self.validate(entries)

    def test_rejects_links_and_missing_contract_files(self) -> None:
        with self.assertRaises(VALIDATOR.ReleaseValidationError):
            self.validate(required_entries(), special=("link", tarfile.SYMTYPE, b"package.json"))
        for required_file in (
            "docker-compose.yml",
            "ops/scripts/_common.sh",
            "ops/scripts/backup.sh",
            "ops/scripts/check-backup.sh",
            "ops/systemd/nginx.service.d/eduri-cd-reconcile.conf",
        ):
            with self.subTest(required_file=required_file):
                entries = required_entries()
                del entries[required_file]
                with self.assertRaisesRegex(
                    VALIDATOR.ReleaseValidationError,
                    re.escape(required_file),
                ):
                    self.validate(entries)

    def test_rejects_declared_unpacked_size_over_limit(self) -> None:
        entries = required_entries()
        entries["one.bin"] = b"12345"
        entries["two.bin"] = b"67890"
        original_limit = VALIDATOR.MAX_UNPACKED_BYTES
        VALIDATOR.MAX_UNPACKED_BYTES = sum(map(len, required_entries().values())) + 9
        self.addCleanup(setattr, VALIDATOR, "MAX_UNPACKED_BYTES", original_limit)
        with self.assertRaises(VALIDATOR.ReleaseValidationError):
            self.validate(entries)


if __name__ == "__main__":
    unittest.main()
