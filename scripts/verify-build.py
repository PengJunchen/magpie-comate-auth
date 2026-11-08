"""Verify CI/release archives against the exact checked-out source commit."""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import zipfile


def verify(root):
    root = Path(root)
    dist = root / 'dist'
    pkg = json.loads((root / 'package.json').read_text())
    info = json.loads((dist / 'BUILD-INFO.json').read_text())
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    assert info['commit'] == sha and info['dirty'] is False, 'Build must match a clean checkout'
    assert info['version'] == pkg['version'] and info['name'] == pkg['name'], 'Package mismatch'
    names = sorted(set(pkg['files'] + ['package.json', 'LICENSE']))
    assert sorted(info['files']) == names, 'Unexpected payload manifest'
    source = {}
    for name in names:
        assert Path(name).name == name and (root / name).is_file(), 'Invalid payload path'
        source[name] = (root / name).read_bytes()
        assert hashlib.sha256(source[name]).hexdigest() == info['files'][name], 'Payload hash mismatch'
    zip_name = f"magpie-comate-auth-{pkg['version']}.zip"
    tgz_name = f"pengjunchen-magpie-comate-auth-{pkg['version']}.tgz"
    with zipfile.ZipFile(dist / zip_name) as archive:
        assert sorted(archive.namelist()) == sorted('magpie-comate-auth/' + n for n in names), 'ZIP payload mismatch'
        assert archive.testzip() is None, 'ZIP CRC mismatch'
        for name in names:
            assert archive.read('magpie-comate-auth/' + name) == source[name], 'ZIP source mismatch'
    with tarfile.open(dist / tgz_name) as archive:
        members = archive.getmembers()
        assert all(m.isfile() for m in members), 'TGZ contains a non-file'
        assert sorted(m.name for m in members) == sorted('package/' + n for n in names), 'TGZ payload mismatch'
        for name in names:
            assert archive.extractfile('package/' + name).read() == source[name], 'TGZ source mismatch'
    expected = {zip_name, tgz_name, 'BUILD-INFO.json'}
    checksums = {}
    for line in (dist / 'SHA256SUMS').read_text().splitlines():
        digest, name = line.split()
        assert name in expected and name not in checksums, 'Unexpected checksum entry'
        checksums[name] = digest
        assert hashlib.sha256((dist / name).read_bytes()).hexdigest() == digest, 'Artifact hash mismatch'
    assert set(checksums) == expected, 'Missing checksum entry'
    print(json.dumps({'verified': True, 'version': pkg['version'], 'commit': sha, 'files': len(names)}))


if __name__ == '__main__':
    verify(Path(__file__).resolve().parent.parent)
