"""Regression: a private broker umask must leave public parser assets readable."""
import ast
import base64
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace

path = Path(__file__).resolve().parents[2]/'tools/transcript-engine/login-diagnostic-oracle.py'
spec = importlib.util.spec_from_file_location('oracle_public_assets', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PublicAssetPermissions(unittest.TestCase):
    def test_public_assets_ignore_private_broker_umask(self):
        tree = ast.parse(module.REMOTE)
        stage = next(node for node in ast.walk(tree) if isinstance(node, ast.If)
            and isinstance(node.test, ast.Name) and node.test.id == 'ASSETS')
        body = b'# public parser fixture\n'
        assets = {'apps/executor/python/transcript_ytdlp.py': {
            'base64':base64.b64encode(body).decode(), 'sha256':hashlib.sha256(body).hexdigest()}}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'public-assets'
            def require(condition, reason):
                if not condition: raise AssertionError(reason)
            previous = os.umask(0o077)
            try:
                exec(compile(ast.Module(body=[stage],type_ignores=[]),'actual-public-stage','exec'),
                    {'ASSETS':assets,'asset_root':root,'base64':base64,'hashlib':hashlib,
                     'trial':SimpleNamespace(require=require)})
            finally:
                os.umask(previous)
            target = root/next(iter(assets))
            self.assertEqual(target.read_bytes(),body)
            if os.name != 'nt':
                self.assertEqual(target.stat().st_mode & 0o777,0o644)
                for parent in [root,*target.parents[:3]]:
                    self.assertEqual(parent.stat().st_mode & 0o777,0o755)


if __name__ == '__main__': unittest.main()
