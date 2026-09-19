#!/usr/bin/env python3
"""Execute the real Bash entrypoints; stub external effects in disposable folders.
No repository network, sudo, model, operational database or Minecraft is touched.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent

GIT = r'''#!/usr/bin/env python3
import os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['TRACE'], 'a') as f: f.write('git ' + ' '.join(args) + '\n')
if args[0] == os.environ.get('GIT_FAIL'): sys.exit(17)
if args[:2] == ['rev-parse', 'HEAD']:
    print('new' if Path('.updated').exists() else 'old')
elif args[0] == 'rev-parse': print('fixture-sha')
elif args[0] == 'status' and os.environ.get('GIT_DIRTY') == '1': print(' M local.ts')
elif args[:2] == ['stash', 'pop'] and os.environ.get('STASH_CONFLICT') == '1': sys.exit(1)
elif args[0] == 'pull' and os.environ.get('GIT_UPDATE') == '1' and not Path('.updated').exists():
    Path('scripts/dev-one-touch.sh').write_text(Path(os.environ['LATEST_LAUNCHER']).read_text())
    Path('.updated').write_text('updated')
'''
NPM = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
settings = {}
if Path('.env').exists():
    for line in Path('.env').read_text().splitlines():
        if '=' in line:
            k, v = line.split('=', 1); settings[k] = v
provider = os.environ.get('POLICY_PROVIDER', settings.get('POLICY_PROVIDER', 'auto'))
with open(os.environ['TRACE'], 'a') as f: f.write('npm ' + ' '.join(args) + ' provider=' + provider + '\n')
if 'check:gameplay' in args:
    issues = []
    if provider not in ('auto', 'openai', 'jev'): issues.append('invalid_policy_provider')
    has_typesafe = bool(os.environ.get('TYPESAFE_API_KEY', settings.get('TYPESAFE_API_KEY', '')))
    effective = 'jev' if provider == 'jev' or (provider == 'auto' and has_typesafe) else 'openai'
    if effective == 'jev': issues.append('configured_adapter_missing_autonomy_tasks')
    if not os.environ.get('OPENAI_API_KEY', settings.get('OPENAI_API_KEY')): issues.append('openai_credential_not_configured')
    if os.environ.get('CHECK_ISSUE'): issues.append(os.environ['CHECK_ISSUE'])
    print(json.dumps({'ready': not issues, 'effectiveProvider': effective,
                      'issues': issues, 'missingTasks': ['SAVE_PROCEDURE'] if effective == 'jev' else [],
                      'executiveModel': 'configured-fixture-model', 'remoteModelVerified': False}))
    sys.exit(int(os.environ.get('CHECK_EXIT', '2' if issues else '0')))
if 'eval:gameplay' in args:
    print('ISOLATED_EVALUATION_FIXTURE: delegated; no real game/model')
    sys.exit(int(os.environ.get('EVAL_EXIT', '124')))
if args == ['ci']: Path('node_modules').mkdir(exist_ok=True)
'''

class OneTouchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='one-touch-')
        self.root = Path(self.tmp.name) / 'repo'
        self.root.mkdir()
        (self.root / 'scripts').mkdir()
        self.bin = Path(self.tmp.name) / 'bin'
        self.bin.mkdir()
        self.trace = Path(self.tmp.name) / 'trace'
        self.trace.write_text('')
        shutil.copy2(ROOT / 'run.sh', self.root / 'run.sh')
        shutil.copy2(ROOT / 'scripts/dev-one-touch.sh', self.root / 'scripts/dev-one-touch.sh')
        (self.root / 'package-lock.json').write_text('{}\n')
        self.state = self.root / '.minecraft-dev'
        (self.state / 'server/world').mkdir(parents=True)
        (self.state / 'server/server.jar').write_text('fixture jar')
        (self.state / 'server/world/keep.dat').write_text('keep world')
        (self.state / 'gameplay.pid').write_text('99999999\n')
        (self.root / 'memory.sqlite').write_text('keep memory')
        self.set_config('openai')
        (self.root / '.env.example').write_text('POLICY_PROVIDER=auto\n')
        self.env = {k: v for k, v in os.environ.items() if k in ('HOME', 'LANG', 'TMPDIR', 'TMP', 'TEMP')}
        self.env.update(PATH=str(self.bin) + os.pathsep + os.environ.get('PATH', ''),
                        TRACE=str(self.trace), GAMEPLAY_VIEWER_ENABLED='0',
                        LATEST_LAUNCHER=str(ROOT / 'scripts/dev-one-touch.sh'))
        self.binary('git', GIT)
        self.binary('npm', NPM)
        self.binary('node', '#!/usr/bin/env bash\n[[ "${1:-}" == "-p" ]] && echo 22\nexit 0\n')
        for command in ('curl', 'java'):
            self.binary(command, '#!/usr/bin/env bash\nprintf "UNEXPECTED %s\\n" "' + command + '" >> "$TRACE"\nexit 99\n')
        self.binary('sudo', '#!/usr/bin/env bash\necho UNEXPECTED_sudo >> "$TRACE"\nexit 99\n')
        for name in ('reset', 'start', 'stop'):
            (self.root / ('scripts/mc-' + name + '-local.sh')).write_text(
                '#!/usr/bin/env bash\nprintf "mc_' + name + ' %s\\n" "$*" >> "$TRACE"\n')

    def tearDown(self):
        self.tmp.cleanup()

    def binary(self, name, text):
        path = self.bin / name
        path.write_text(text.replace('#!/usr/bin/env python3', '#!' + sys.executable + ' -S', 1))
        path.chmod(0o755)

    def set_config(self, provider, typesafe=False):
        self.config = 'LLM_PROVIDER=keep-this\nPOLICY_PROVIDER=' + provider + '\nOPENAI_API_KEY=fixture-secret-do-not-print\n'
        if typesafe: self.config += 'TYPESAFE_API_KEY=fixture-typesafe-secret\n'
        (self.root / '.env').write_text(self.config)

    def run_launcher(self, *args, answer=''):
        self.result = subprocess.run(['bash', 'run.sh', *args], cwd=self.root, env=self.env,
                                     input=answer, capture_output=True, text=True, timeout=12)
        self.actions = self.trace.read_text()
        self.output = self.result.stdout + self.result.stderr
        self.assertNotIn('UNEXPECTED', self.actions)
        self.assertNotIn('fixture-secret-do-not-print', self.output)
        self.assertNotIn('fixture-typesafe-secret', self.output)
        return self.result.returncode

    def no_game(self):
        self.assertNotIn('mc_', self.actions)
        self.assertNotIn('start:gameplay', self.actions)
        self.assertNotIn('eval:gameplay', self.actions)
        self.assertEqual((self.state / 'gameplay.pid').read_text(), '99999999\n')
        self.assertEqual((self.state / 'server/world/keep.dat').read_text(), 'keep world')
        self.assertEqual((self.root / 'memory.sqlite').read_text(), 'keep memory')

    def test_shell_syntax(self):
        for file in ('run.sh', 'scripts/dev-one-touch.sh'):
            self.assertEqual(subprocess.run(['bash', '-n', str(ROOT / file)]).returncode, 0)

    def test_default_keeps_reset_after_successful_check(self):
        self.assertEqual(self.run_launcher(), 0, self.output)
        self.assertLess(self.actions.index('check:gameplay'), self.actions.index('mc_reset'))
        self.assertLess(self.actions.index('mc_reset'), self.actions.index('mc_start'))
        self.assertLess(self.actions.index('mc_start'), self.actions.index('start:gameplay'))
        self.assertIn('mc_reset 8675309', self.actions)
        self.assertEqual((self.root / '.env').read_text(), self.config)

    def test_continue_never_resets(self):
        self.assertEqual(self.run_launcher('continue'), 0, self.output)
        self.assertNotIn('mc_reset', self.actions)
        self.assertIn('mc_start', self.actions)
        self.assertIn('start:gameplay', self.actions)

    def test_explicit_reset_seed_retained(self):
        self.assertEqual(self.run_launcher('reset', '-123'), 0, self.output)
        self.assertIn('mc_reset -123', self.actions)

    def test_blocked_default_does_not_touch_game_or_config(self):
        self.set_config('auto', typesafe=True)
        self.assertEqual(self.run_launcher(), 2, self.output)
        self.no_game()
        self.assertEqual((self.root / '.env').read_text(), self.config)

    def test_blocked_continue_does_not_stop_existing_game(self):
        self.set_config('jev', typesafe=True)
        self.assertEqual(self.run_launcher('continue'), 2, self.output)
        self.no_game()

    def test_check_only_updates_and_reports(self):
        self.assertEqual(self.run_launcher('check'), 0, self.output)
        self.assertIn('git pull --ff-only', self.actions)
        self.assertIn('npm ci', self.actions)
        self.no_game()
        self.assertEqual((self.root / '.env').read_text(), self.config)

    def test_check_missing_env_does_not_create_or_prompt_for_secret(self):
        (self.root / '.env').unlink()
        self.assertEqual(self.run_launcher('check'), 2, self.output)
        self.assertFalse((self.root / '.env').exists())
        self.assertNotIn('First run only', self.output)
        self.no_game()

    def test_missing_script_error_does_not_start_game(self):
        self.env['CHECK_EXIT'] = '1'
        self.assertEqual(self.run_launcher('eval'), 1, self.output)
        self.no_game()

    def test_eval_one_command_is_bounded_and_keeps_operational_world(self):
        self.assertEqual(self.run_launcher('eval'), 124, self.output)
        self.assertIn('npm run eval:gameplay -- --run --seconds=60 provider=openai', self.actions)
        self.assertNotIn('mc_', self.actions)
        self.assertNotIn('start:gameplay', self.actions)
        self.assertEqual((self.state / 'gameplay.pid').read_text(), '99999999\n')
        self.assertEqual((self.root / '.env').read_text(), self.config)
        self.assertIn('60秒の試験時間上限', self.output)

    def test_eval_declining_alternative_does_not_start(self):
        self.set_config('auto', typesafe=True)
        self.assertEqual(self.run_launcher('eval', answer='n\n'), 2, self.output)
        self.no_game()
        self.assertEqual((self.root / '.env').read_text(), self.config)

    def test_eval_eof_is_not_consent(self):
        self.set_config('jev', typesafe=True)
        self.assertEqual(self.run_launcher('eval'), 2, self.output)
        self.no_game()

    def test_eval_explicit_consent_is_process_local_only(self):
        self.set_config('jev', typesafe=True)
        self.assertEqual(self.run_launcher('eval', answer='y\n'), 124, self.output)
        self.assertIn('--run --seconds=60 provider=openai', self.actions)
        self.assertNotIn('mc_', self.actions)
        self.assertEqual((self.root / '.env').read_text(), self.config)
        self.assertNotIn('POLICY_PROVIDER', self.env)
        self.assertIn('Operator approved OpenAI', self.output)

    def test_other_config_error_never_offers_switch(self):
        self.set_config('jev', typesafe=True)
        self.env['CHECK_ISSUE'] = 'invalid_policy_timeout'
        self.assertEqual(self.run_launcher('eval', answer='y\n'), 2, self.output)
        self.assertNotIn('今回だけOpenAI経路', self.output)
        self.no_game()

    def test_eval_failure_preserves_exit_code_and_log(self):
        self.env['EVAL_EXIT'] = '23'
        self.assertEqual(self.run_launcher('eval'), 23, self.output)
        self.assertIn('終了コード 23', self.output)
        self.assertIn('共有するログファイル:', self.output)
        log = self.root / 'logs/gameplay/latest.log'
        self.assertTrue(log.is_symlink())
        self.assertIn('ISOLATED_EVALUATION_FIXTURE', log.read_text())
        self.assertNotIn('fixture-secret', log.read_text())

    def test_failed_fetch_cannot_continue(self):
        self.env['GIT_FAIL'] = 'fetch'
        self.assertEqual(self.run_launcher('eval'), 17, self.output)
        self.assertNotIn('check:gameplay', self.actions)
        self.no_game()

    def test_conflicted_stash_cannot_continue(self):
        self.env.update(GIT_DIRTY='1', STASH_CONFLICT='1')
        self.assertEqual(self.run_launcher('eval'), 1, self.output)
        self.assertNotIn('check:gameplay', self.actions)
        self.no_game()

    def test_updated_launcher_reexec_preserves_eval_mode(self):
        self.env['GIT_UPDATE'] = '1'
        self.assertEqual(self.run_launcher('eval'), 124, self.output)
        self.assertIn('restarting with newest launcher', self.output)
        self.assertEqual(self.actions.count('npm run eval:gameplay'), 1)
        self.assertNotIn('mc_', self.actions)

    def test_legacy_reexec_argument_contract_reaches_new_check(self):
        # The old launcher passes MODE plus RESET_SEED unconditionally. Model
        # that exact bridge, so check/eval must tolerate its irrelevant seed.
        current = (ROOT / 'scripts/dev-one-touch.sh').read_text()
        start = current.index('sync_repository() {')
        end = current.index('\nensure_system_dependencies()', start)
        legacy = '\n'.join(['#!/usr/bin/env bash', 'set -euo pipefail',
            'ROOT_DIR="$(pwd)"', 'BRANCH=revive/gameplay-first-jev',
            'MODE="${1:-reset}"', 'RESET_SEED="${2:-8675309}"',
            'log() { printf "%s\\n" "$*"; }', current[start:end],
            'sync_repository', 'echo legacy_fellthrough >> "$TRACE"', 'exit 88'])
        (self.root / 'scripts/dev-one-touch.sh').write_text(legacy)
        self.env['GIT_UPDATE'] = '1'
        self.assertEqual(self.run_launcher('check'), 0, self.output)
        self.assertNotIn('legacy_fellthrough', self.actions)
        self.no_game()

    def test_unknown_mode_cannot_start_game(self):
        self.assertEqual(self.run_launcher('evla'), 64, self.output)
        self.no_game()

if __name__ == '__main__':
    unittest.main(verbosity=2)
