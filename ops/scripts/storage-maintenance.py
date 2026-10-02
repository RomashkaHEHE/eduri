#!/usr/bin/env python3
"""Bound Eduri Docker storage without touching data, volumes or recovery."""

import argparse
import contextlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

APP_ROOT = Path('/home/user1/eduri')
STATE_ROOT = Path('/var/lib/eduri-cd')
MANAGED_REPOSITORIES = {'eduri-app', 'eduri-livekit', 'livekit/livekit-server', 'clamav/clamav'}
PINNED_TAGS = {'eduri-app:production', 'eduri-app:latest'}
MIN_FREE_BYTES = 10 * 1024**3


def docker(*args):
    return subprocess.check_output(['/usr/bin/docker', *args], text=True).strip()


def image_repositories(image):
    return {tag.rsplit(':', 1)[0] for tag in image.get('RepoTags') or []} | {
        digest.split('@', 1)[0] for digest in image.get('RepoDigests') or []
    }


def plan_images(images, container_images, keep_previous=2):
    """Keep all container references, pinned tags and newest previous app images."""
    protected = set(container_images)
    protected.update(image['Id'] for image in images
                     if PINNED_TAGS.intersection(image.get('RepoTags') or []))
    previous = sorted(
        (image for image in images if 'eduri-app' in image_repositories(image)
         and image['Id'] not in protected),
        key=lambda image: (image['Created'], image['Id']), reverse=True,
    )
    protected.update(image['Id'] for image in previous[:keep_previous])
    candidates = []
    for image in images:
        repositories = image_repositories(image)
        if (image['Id'] not in protected and repositories
                and repositories <= MANAGED_REPOSITORIES):
            candidates.append(image)
    return candidates, protected


def recovery_pending(state_root=STATE_ROOT, gate=Path('/etc/eduri/maintenance')):
    if gate.exists() or gate.is_symlink():
        return True
    recovery_root = state_root / 'recovery'
    if recovery_root.is_symlink():
        raise RuntimeError('unsafe recovery directory')
    if recovery_root.exists() and any(recovery_root.iterdir()):
        return True
    jobs_root = state_root / 'jobs'
    if jobs_root.is_symlink():
        raise RuntimeError('unsafe jobs directory')
    if jobs_root.exists():
        for job in jobs_root.iterdir():
            if job.is_symlink() or not job.is_dir():
                return True
            terminals = [job / name for name in ('succeeded', 'failed')]
            if not any(marker.is_file() and not marker.is_symlink() for marker in terminals):
                return True
    return False


@contextlib.contextmanager
def maintenance_locks():
    import fcntl
    import stat

    for directory in (APP_ROOT, STATE_ROOT):
        if not directory.is_dir() or directory.resolve() != directory:
            raise RuntimeError(f'unsafe or missing directory: {directory}')
    # Same order as CD. Nonblocking acquisition makes timer runs skip busy deploys.
    descriptors = []
    try:
        for path, create in ((STATE_ROOT / 'queue.lock', True),
                             (APP_ROOT / '.maintenance.lock', False)):
            flags = os.O_RDWR | os.O_NOFOLLOW | (os.O_CREAT if create else 0)
            descriptor = os.open(path, flags, 0o600)
            descriptors.append(descriptor)
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise RuntimeError(f'unsafe lock file: {path}')
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def inventory():
    container_ids = docker('ps', '-aq').split()
    container_images = set(docker('inspect', '--format', '{{.Image}}',
                                 *container_ids).split()) if container_ids else set()
    image_ids = sorted(set(docker('image', 'ls', '-aq', '--no-trunc').split()))
    images = json.loads(docker('image', 'inspect', *image_ids)) if image_ids else []
    return images, container_images


def clean_storage(apply=False):
    if recovery_pending():
        print('Skipped: Eduri recovery or deployment is pending.', flush=True)
        return
    # Fail before removing images if this Docker lacks bounded Buildx pruning.
    help_text = docker('buildx', 'prune', '--help')
    if '--max-used-space' not in help_text or '--min-free-space' not in help_text:
        raise RuntimeError('bounded Buildx pruning is required')
    images, container_images = inventory()
    candidates, protected = plan_images(images, container_images)
    print(f'Protected images: {len(protected)}; removable Eduri images: {len(candidates)}', flush=True)
    for image in candidates:
        references = image.get('RepoTags') or [image['Id']]
        print(f"Remove: {image['Id']} {references}", flush=True)
        if apply:
            # Never force deletion: Docker additionally protects container references.
            for reference in references:
                subprocess.run(['/usr/bin/docker', 'image', 'rm', reference], check=True)
    prune_args = ['buildx', 'prune', '--builder', 'default', '--force',
                  '--max-used-space', '4GB', '--min-free-space', '10GB']
    print('Cache policy: target 4GB; target free space 10GB.', flush=True)
    if apply:
        subprocess.run(['/usr/bin/docker', *prune_args], check=True)
        # Verify every retained image still exists; do not silently lose rollback.
        if protected:
            docker('image', 'inspect', '--format', '{{.Id}}', *sorted(protected))
    usage = shutil.disk_usage(APP_ROOT)
    print(f'Disk bytes: total={usage.total} used={usage.used} free={usage.free}', flush=True)
    if apply and usage.free < MIN_FREE_BYTES:
        raise RuntimeError('free disk remains below 10GiB; inspect storage manually')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='apply cleanup (default: dry run)')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('run as root')
    try:
        with maintenance_locks():
            clean_storage(args.apply)
    except BlockingIOError:
        print('Skipped: Eduri deployment or backup is active.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        sys.exit(1)
