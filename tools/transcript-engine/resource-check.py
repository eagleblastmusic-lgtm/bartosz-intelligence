"""Real timeout, memory exhaustion and cancellation tests, no caption/network input."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import threading


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    supervisor = Path(__file__).with_name('supervise.py')
    cancel = args.output / 'cancel.request'
    cases = {
        'TIMEOUT': (['--timeout', '0.3'], 'setInterval(()=>{},1000)'),
        'MEMORY_LIMIT': (['--memory-mib', '64', '--timeout', '5'],
                         'globalThis.x=Buffer.alloc(96*1024*1024,1);setInterval(()=>{},1000)'),
        'CANCELLED': (['--cancel-file', str(cancel), '--timeout', '5'], 'setInterval(()=>{},1000)')}
    results = []
    for category, (flags, code) in cases.items():
        receipt = args.output / (category.lower() + '.json')
        timer = threading.Timer(0.5, lambda: cancel.write_text('cancel\n', encoding='ascii')) if category == 'CANCELLED' else None
        if timer:
            timer.start()
        try:
            run = subprocess.run([sys.executable, '-B', str(supervisor), '--output', str(receipt)] + flags +
                ['--', str(args.node.resolve()), '-e', code], capture_output=True, timeout=10)
        finally:
            if timer:
                timer.cancel()
        result = json.loads(receipt.read_text(encoding='utf-8'))
        assert run.returncode == 2, (category, run.returncode)
        assert result['category'] == category, (category, result['category'])
        assert result['descendants_remaining'] == 0, category
        results.append({'test': category, 'status': 'PASS', 'receipt': receipt.name,
                        'elapsed_ms': result['elapsed_ms'], 'peak_tree_rss_bytes': result['peak_tree_rss_bytes']})
    report = {'schema': 'ote-resource-check:1', 'status': 'PASS', 'test_count': len(results), 'results': results}
    (args.output / 'resources.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
