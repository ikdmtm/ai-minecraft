#!/usr/bin/env python3
"""Offline fixtures verify vanilla JAR export, cache, and bundled integrity."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('exporter', Path(__file__).with_name('mc-export-knowledge.py'))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


def fixture():
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as archive:
        archive.writestr(zipfile.ZipInfo('version.json'), json.dumps({'id': '1.21.4'}))
        archive.writestr(zipfile.ZipInfo('data/minecraft/recipe/cooked_chicken.json'), json.dumps({'type': 'minecraft:smelting', 'ingredient': 'minecraft:chicken', 'result': {'id': 'minecraft:cooked_chicken'}}))
        archive.writestr(zipfile.ZipInfo('data/minecraft/tags/item/logs.json'), json.dumps({'values': ['minecraft:oak_log']}))
    return data.getvalue()


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.jar = self.root / 'server.jar'
        self.output = self.root / 'data' / 'facts.json'

    def tearDown(self):
        self.tmp.cleanup()

    def test_direct_export_preserves_raw_spec_and_version(self):
        self.jar.write_bytes(fixture())
        data = exporter.export(self.jar, self.output)
        self.assertEqual(data['version'], '1.21.4')
        self.assertEqual(data['recipes']['minecraft:cooked_chicken']['ingredient'], 'minecraft:chicken')
        self.assertIn('minecraft:item/logs', data['tags'])

    def test_cache_does_not_rewrite_unchanged_jar(self):
        self.jar.write_bytes(fixture())
        first = exporter.export(self.jar, self.output)
        stamp = self.output.stat().st_mtime_ns
        self.assertEqual(first, exporter.export(self.jar, self.output))
        self.assertEqual(stamp, self.output.stat().st_mtime_ns)

    def bundle(self, digest):
        inner = fixture()
        with zipfile.ZipFile(self.jar, 'w') as archive:
            archive.writestr('META-INF/versions.list', digest + '\t1.21.4\t1.21.4/server.jar\n')
            archive.writestr('META-INF/versions/1.21.4/server.jar', inner)

    def test_bundled_server_is_unwrapped(self):
        self.bundle(hashlib.sha256(fixture()).hexdigest())
        self.assertEqual(exporter.export(self.jar, self.output)['version'], '1.21.4')

    def test_modified_inner_jar_is_rejected(self):
        self.bundle('0' * 64)
        with self.assertRaisesRegex(ValueError, 'checksum'):
            exporter.export(self.jar, self.output)
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
