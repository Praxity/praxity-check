#!/usr/bin/env python3
"""Synthetic runner checks; no model requests. Run: python3 bench/pdf/run.test.py."""
import hashlib
import importlib.util
import json
from pathlib import Path
import signal
import sys
import tempfile
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('runner', Path(__file__).with_name('run.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

with tempfile.TemporaryDirectory(prefix='pdf-runner-test-') as temporary:
    root = Path(temporary).resolve()
    bundle = root / 'source'
    bundle.mkdir()
    (bundle / 'manifest.json').write_text(json.dumps({'artifacts': [{'image': 'page-1.png', 'facts': 'page-1.json'}]}))
    for name in ['review-prompt.md', 'review.schema.json', 'page-1.png', 'page-1.json']:
        (bundle / name).write_text('{}')
    (bundle / 'answer-key.json').write_text('never copy this')
    (bundle / 'design-page-1.json').write_text('{"fontSizePt": 5}')
    manifest = json.loads((bundle / 'manifest.json').read_text())
    manifest['designEvidence'] = {'artifacts': [{'path': 'design-page-1.json', 'sha256': hashlib.sha256((bundle / 'design-page-1.json').read_bytes()).hexdigest()}]}
    (bundle / 'manifest.json').write_text(json.dumps(manifest))
    secret = root / 'secret.txt'
    secret.write_text('protected')
    fake = root / 'fake-codex'
    fake.write_text(f'''#!{sys.executable}
import json, pathlib, sys, time
model = sys.argv[sys.argv.index('-m') + 1]
assert pathlib.Path('page-1.png').read_text() == '{{}}'
assert not pathlib.Path('answer-key.json').exists()
assert json.loads(pathlib.Path('design-page-1.json').read_text())['fontSizePt'] == 5
try:
    pathlib.Path({str(secret)!r}).read_text()
except PermissionError:
    pass
else:
    raise AssertionError('protected data readable')
assert sys.stdin.read() == {runner.PROMPT!r}.format(model=model)
assert '--ephemeral' in sys.argv and 'resume' not in sys.argv
assert '--output-schema' not in sys.argv
assert sys.argv[sys.argv.index('-s') + 1] == 'danger-full-access'
for blocked in ['design-page-1.json', 'manifest.json', {str(secret)!r}, 'sandbox.sb', 'run-prompt.md']:
    try:
        pathlib.Path(blocked).write_text('forbidden')
    except PermissionError:
        pass
    else:
        raise AssertionError('forbidden write succeeded')
print(json.dumps({{'model': model}}), flush=True)
if model == 'timeout': time.sleep(60)
if model == 'failed': sys.exit(7)
pathlib.Path('review.json').write_text(json.dumps({{'reviewer': {{'model': model}}}}))
''')
    fake.chmod(0o700)
    plan = {'seed': 1234, 'workers': 3, 'timeoutSeconds': 5, 'repeats': 1,
            'models': [{'id': name, 'effort': 'low'} for name in ['ok', 'failed', 'timeout']],
            'cases': [{'id': 'synthetic', 'bundlePath': str(bundle)}],
            'protectedPaths': [str(secret)], 'codexPath': str(fake)}
    plan_path = root / 'input-plan.json'
    plan_path.write_text(json.dumps(plan))
    with patch.object(runner.os, 'killpg', wraps=runner.os.killpg) as kill_group:
        first = runner.run(plan_path, root / 'first')
        plan['cases'][0]['id'] = 'another-synthetic-case'
        plan_path.write_text(json.dumps(plan))
        second = runner.run(plan_path, root / 'second')
    assert kill_group.call_count == 2
    assert all(call.args[0] > 0 and call.args[1] == signal.SIGKILL for call in kill_group.call_args_list)
    assert all(r['exitCode'] == -signal.SIGKILL for r in first + second if r['model'] == 'timeout')
    assert [r['model'] for r in first] == [r['model'] for r in second]
    statuses = {r['model']: r['status'] for r in first}
    assert statuses == {'ok': 'complete', 'failed': 'failed', 'timeout': 'timeout'}, first
    assert next(r for r in first if r['model'] == 'failed')['exitCode'] == 7
    for model in ['ok', 'failed', 'timeout']:
        assert len({r['promptSha256'] for r in first + second if r['model'] == model}) == 1
    assert len({r['promptSha256'] for r in first}) == 3
    assert len({runner.PROMPT.format(model=r['model']).split('Runner model identifier:')[0] for r in first}) == 1
    assert (root / 'first' / 'run-prompt-template.md').read_text() == runner.PROMPT
    for record in first:
        trial = root / 'first' / record['trialId']
        assert (trial / 'result.json').exists()
        assert (trial / 'run-prompt.md').read_text() == runner.PROMPT.format(model=record['model'])
        assert (trial / 'stdout.jsonl').exists()
        assert (trial / 'stderr.log').exists()
        assert 'Operation not permitted' in (trial / 'probe.stderr').read_text()
        assert 'answer-key.json' not in record['bundleHashes']
    original_invoke = runner.invoke
    def cancel_after_model(*args, **kwargs):
        result = original_invoke(*args, **kwargs)
        if args[0][3] == str(fake):
            (args[1].parent / 'CANCEL').touch()
        return result
    runner.invoke = cancel_after_model
    plan['workers'] = 1
    plan['models'] = [{'id': 'ok', 'effort': 'low'}]
    plan['repeats'] = 3
    plan_path.write_text(json.dumps(plan))
    cancelled = runner.run(plan_path, root / 'cancelled')
    assert [r['status'] for r in cancelled] == ['complete', 'cancelled', 'cancelled']
    assert (root / 'cancelled' / 'runner.pid').read_text().strip().isdigit()
    runner.invoke = original_invoke
    (bundle / 'design-page-1.json').write_text('tampered')
    tampered = runner.run(plan_path, root / 'tampered')
    assert len(tampered) == 3 and all(r['status'] == 'setup-failed' and 'hash mismatch' in r['error'] for r in tampered)
    (bundle / 'design-page-1.json').write_text('{"fontSizePt": 5}')
    # A rejected bundle is still recorded for every planned model attempt.
    (bundle / 'page-1.png').unlink()
    (bundle / 'page-1.png').symlink_to(secret)
    rejected = runner.run(plan_path, root / 'rejected')
    assert len(rejected) == 3 and all(r['status'] == 'setup-failed' for r in rejected)
    assert all('symlinks' in r['error'] for r in rejected)
print('Runner checks passed: isolation, failures, timeout, fixed order, model metadata prompts, cancellation, rejected bundles.')
