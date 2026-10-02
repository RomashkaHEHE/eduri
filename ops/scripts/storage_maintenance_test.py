import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'storage_maintenance', Path(__file__).with_name('storage-maintenance.py'))
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


def image(name, date, tags=None, digests=None):
    return {'Id': name, 'Created': date, 'RepoTags': tags or [], 'RepoDigests': digests or []}


class StorageTests(unittest.TestCase):
    def test_retains_running_and_stopped_containers_and_two_previous_versions(self):
        images = [image('running', '6', ['eduri-app:production']),
                  image('stopped', '1', ['eduri-app:cd-old']),
                  image('previous', '5', ['eduri-app:cd-previous']),
                  image('older', '4', ['eduri-app:rollback-older']),
                  image('remove', '3', ['eduri-app:cd-expired'])]
        candidates, protected = storage.plan_images(images, {'running', 'stopped'})
        self.assertEqual({entry['Id'] for entry in candidates}, {'remove'})
        self.assertEqual(protected, {'running', 'stopped', 'previous', 'older'})

    def test_never_removes_pinned_or_foreign_images(self):
        images = [image('latest', '1', ['eduri-app:latest']),
                  image('foreign', '2', ['other-app:old']),
                  image('mixed', '3', ['eduri-app:old', 'other-app:pinned']),
                  image('untagged', '4')]
        candidates, _ = storage.plan_images(images, set(), keep_previous=0)
        self.assertEqual(candidates, [])

    def test_old_scanner_can_be_removed_but_current_scanner_is_kept(self):
        images = [image('old', '1', digests=['clamav/clamav@sha256:old']),
                  image('current', '2', digests=['clamav/clamav@sha256:new'])]
        candidates, _ = storage.plan_images(images, {'current'})
        self.assertEqual([entry['Id'] for entry in candidates], ['old'])

    def test_unfinished_job_gate_and_recovery_block_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gate = root / 'maintenance'
            self.assertFalse(storage.recovery_pending(root, gate))
            job = root / 'jobs' / 'job.release.ready'
            job.mkdir(parents=True)
            self.assertTrue(storage.recovery_pending(root, gate))
            (job / 'succeeded').write_text('release')
            self.assertFalse(storage.recovery_pending(root, gate))
            recovery = root / 'recovery' / 'snapshot'
            recovery.mkdir(parents=True)
            self.assertTrue(storage.recovery_pending(root, gate))
            recovery.rmdir()
            gate.touch()
            self.assertTrue(storage.recovery_pending(root, gate))

    def test_pending_recovery_does_not_even_call_docker(self):
        with patch.object(storage, 'recovery_pending', return_value=True), \
                patch.object(storage, 'docker') as docker, contextlib.redirect_stdout(io.StringIO()):
            storage.clean_storage(apply=True)
            docker.assert_not_called()

    def test_dry_run_never_mutates_docker(self):
        with patch.object(storage, 'recovery_pending', return_value=False), \
                patch.object(storage, 'docker', return_value='--max-used-space --min-free-space'), \
                patch.object(storage, 'inventory', return_value=([], set())), \
                patch.object(storage.subprocess, 'run') as run, \
                patch.object(storage.shutil, 'disk_usage', return_value=shutil_usage()), \
                contextlib.redirect_stdout(io.StringIO()):
            storage.clean_storage()
            run.assert_not_called()

    def test_deletion_failure_aborts_before_cache_cleanup(self):
        images = [image('old-scanner', '1', digests=['clamav/clamav@sha256:old'])]
        with patch.object(storage, 'recovery_pending', return_value=False), \
                patch.object(storage, 'docker', return_value='--max-used-space --min-free-space'), \
                patch.object(storage, 'inventory', return_value=(images, set())), \
                patch.object(storage.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'rm')) as run, \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(subprocess.CalledProcessError):
                storage.clean_storage(apply=True)
            self.assertEqual(run.call_count, 1)
            self.assertNotIn('--force', run.call_args.args[0])

    def test_apply_bounds_cache_and_never_prunes_volumes(self):
        with patch.object(storage, 'recovery_pending', return_value=False), \
                patch.object(storage, 'docker', return_value='--max-used-space --min-free-space'), \
                patch.object(storage, 'inventory', return_value=([], set())), \
                patch.object(storage.subprocess, 'run') as run, \
                patch.object(storage.shutil, 'disk_usage', return_value=shutil_usage()), \
                contextlib.redirect_stdout(io.StringIO()):
            storage.clean_storage(apply=True)
            run.assert_called_once_with(
                ['/usr/bin/docker', 'buildx', 'prune', '--builder', 'default', '--force',
                 '--max-used-space', '4GB', '--min-free-space', '10GB'], check=True)

    @unittest.skipUnless(__import__('sys').platform == 'linux', 'Linux flock integration')
    def test_busy_maintenance_lock_prevents_cleanup(self):
        import fcntl
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'app'
            state = root / 'state'
            app.mkdir()
            state.mkdir()
            lock = app / '.maintenance.lock'
            lock.touch()
            with lock.open('r+') as held, patch.object(storage, 'APP_ROOT', app), \
                    patch.object(storage, 'STATE_ROOT', state):
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(BlockingIOError):
                    with storage.maintenance_locks():
                        self.fail('entered a busy maintenance section')
                fcntl.flock(held, fcntl.LOCK_UN)
                with storage.maintenance_locks():
                    pass


def shutil_usage():
    from collections import namedtuple
    return namedtuple('usage', 'total used free')(50 * 1024**3, 5 * 1024**3, 45 * 1024**3)


if __name__ == '__main__':
    unittest.main()
