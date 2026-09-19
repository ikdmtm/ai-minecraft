#!/usr/bin/env python3
"""Export neutral vanilla facts from the installed server JAR; no network or strategy data."""
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import zipfile


def export(jar_path: Path, destination: Path) -> dict:
    stat = jar_path.stat()
    fingerprint = f"{jar_path.resolve()}:{stat.st_size}:{stat.st_mtime_ns}"
    if destination.is_file():
        try:
            existing = json.loads(destination.read_text())
            if existing.get('fingerprint') == fingerprint:
                return existing
        except (ValueError, OSError):
            pass
    payload = jar_path.read_bytes()
    archive = zipfile.ZipFile(io.BytesIO(payload))
    if 'META-INF/versions.list' in archive.namelist():
        rows = [line.split('\t') for line in archive.read('META-INF/versions.list').decode().splitlines() if line.strip()]
        if len(rows) != 1 or len(rows[0]) != 3:
            raise ValueError('Ambiguous bundled server version; refusing to select an arbitrary JAR')
        expected_hash, _, relative = rows[0]
        inner = archive.read('META-INF/versions/' + relative)
        if hashlib.sha256(inner).hexdigest() != expected_hash:
            raise ValueError('Bundled server JAR checksum mismatch')
        archive.close()
        archive = zipfile.ZipFile(io.BytesIO(inner))
    with archive:
        version = json.loads(archive.read('version.json'))['id']
        result = {'schema': 1, 'version': version, 'fingerprint': fingerprint,
                  'sourceSha256': hashlib.sha256(payload).hexdigest(), 'recipes': {}, 'tags': {}}
        for name in archive.namelist():
            if not name.endswith('.json'):
                continue
            for prefix, target in [('data/minecraft/recipe/', 'recipes'), ('data/minecraft/tags/', 'tags')]:
                if name.startswith(prefix):
                    result[target]['minecraft:' + name[len(prefix):-5]] = json.loads(archive.read(name))
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_suffix(destination.suffix + '.tmp')
    temp.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    os.replace(temp, destination)
    return result


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: mc-export-knowledge.py SERVER_JAR OUTPUT_JSON')
    facts = export(Path(sys.argv[1]), Path(sys.argv[2]))
    print(f"[mc:knowledge] version={facts['version']} recipes={len(facts['recipes'])} tags={len(facts['tags'])}")
