#!/usr/bin/env python3
"""Validate and safely extract an Eduri continuous-deployment archive."""

from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import sys
import tarfile


MAX_MEMBERS = 20_000
MAX_UNPACKED_BYTES = 256 * 1024 * 1024
MAX_PATH_BYTES = 4_096
REQUIRED_FILES = {
    "Dockerfile",
    "docker-compose.yml",
    "package-lock.json",
    "package.json",
    "ops/certbot/reload-nginx.sh",
    "ops/nginx/eduri.ru.conf",
    "ops/scripts/_common.sh",
    "ops/scripts/backup.sh",
    "ops/scripts/cd-receive.sh",
    "ops/scripts/cd-worker.sh",
    "ops/scripts/cd-validate-helpers.sh",
    "ops/scripts/check-backup.sh",
    "ops/scripts/deploy.sh",
    "ops/scripts/install-edge-config.sh",
    "ops/scripts/validate_cd_release.py",
    "ops/systemd/eduri-cd-reconcile.service",
    "ops/systemd/nginx.service.d/eduri-cd-reconcile.conf",
}
FORBIDDEN_ROOTS = {
    ".env",
    ".git",
    ".maintenance.lock",
    ".qa-board-v2",
    "backups",
    "data",
    "data-dev",
}
FORBIDDEN_PREFIXES = (
    ".restore.",
    "data.failed-restore-",
    "data.pre-restore-",
    "qa-data-",
)
FORBIDDEN_BASENAMES = {
    ".authinfo",
    ".authinfo.gpg",
    ".git-credentials",
    ".netrc",
    ".npmrc",
    ".pnpmrc",
    ".pypirc",
    ".yarnrc",
    ".yarnrc.yml",
}
FORBIDDEN_PRIVATE_SUFFIX = re.compile(
    r"(?:^|\.)(?:db|jks|key|keystore|p12|p8|pem|pfx|pk8|ppk|shm|sqlite3?|wal)$",
    re.IGNORECASE,
)


class ReleaseValidationError(Exception):
    pass


def validated_parts(name: str) -> tuple[str, ...]:
    if not name or name.startswith("/") or "\\" in name or "\0" in name:
        raise ReleaseValidationError(f"unsafe archive path: {name!r}")
    trimmed = name[:-1] if name.endswith("/") else name
    parts = tuple(trimmed.split("/"))
    if not trimmed or any(part in {"", ".", ".."} for part in parts):
        raise ReleaseValidationError(f"unsafe archive path: {name!r}")
    if len(name.encode("utf-8")) > MAX_PATH_BYTES:
        raise ReleaseValidationError("archive path is too long")
    root = parts[0]
    if root in FORBIDDEN_ROOTS or root.startswith(FORBIDDEN_PREFIXES):
        raise ReleaseValidationError(f"forbidden release path: {name}")
    for part in parts:
        lower = part.lower()
        if lower in FORBIDDEN_BASENAMES:
            raise ReleaseValidationError(f"forbidden credential path: {name}")
        if lower == ".env" or (lower.startswith(".env.") and lower != ".env.example"):
            raise ReleaseValidationError(f"forbidden environment path: {name}")
        if FORBIDDEN_PRIVATE_SUFFIX.search(lower):
            raise ReleaseValidationError(f"forbidden private-data path: {name}")
    return parts


def safe_destination(root: Path, parts: tuple[str, ...]) -> Path:
    destination = root.joinpath(*parts)
    if not destination.is_relative_to(root):
        raise ReleaseValidationError("archive path escapes the staging directory")
    return destination


def validate_and_extract(archive_path: Path, destination: Path) -> None:
    if destination.exists() and any(destination.iterdir()):
        raise ReleaseValidationError("staging directory must be empty")
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination = destination.resolve(strict=True)

    seen: set[str] = set()
    regular_files: set[str] = set()
    total_size = 0
    with tarfile.open(archive_path, mode="r:gz") as archive:
        members = archive.getmembers()
        if not members or len(members) > MAX_MEMBERS:
            raise ReleaseValidationError("archive has an invalid member count")

        for member in members:
            parts = validated_parts(member.name)
            normalized = "/".join(parts)
            if normalized in seen:
                raise ReleaseValidationError(f"duplicate archive path: {normalized}")
            seen.add(normalized)
            if not (member.isdir() or member.isfile()):
                raise ReleaseValidationError(
                    f"archive contains a link or special file: {normalized}",
                )
            if member.isfile():
                total_size += member.size
                if member.size < 0 or total_size > MAX_UNPACKED_BYTES:
                    raise ReleaseValidationError("archive expands past the size limit")
                regular_files.add(normalized)

        missing = sorted(REQUIRED_FILES - regular_files)
        if missing:
            raise ReleaseValidationError(
                f"archive is missing required files: {', '.join(missing)}",
            )

        for member in members:
            parts = validated_parts(member.name)
            target = safe_destination(destination, parts)
            if member.isdir():
                target.mkdir(mode=0o755, parents=True, exist_ok=True)
                continue
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise ReleaseValidationError(f"cannot read archive member: {member.name}")
            try:
                with target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
            finally:
                source.close()
            os.chmod(target, 0o755 if member.mode & 0o111 else 0o644)


def main() -> int:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} ARCHIVE DESTINATION", file=sys.stderr)
        return 2
    try:
        validate_and_extract(Path(sys.argv[1]), Path(sys.argv[2]))
    except (OSError, tarfile.TarError, ReleaseValidationError) as error:
        print(f"ERROR: invalid deployment archive: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
