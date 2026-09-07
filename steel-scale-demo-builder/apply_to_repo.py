#!/usr/bin/env python3
"""Stage the reviewed on-demand demo overlay. Dry-run by default. Never commits, pushes, or migrates."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

PACKAGE = Path(__file__).resolve().parent
# Git blob hashes of the exact repository files inspected through the GitHub connector.
EXPECTED = {
    'src/app.ts': '22d0a308acc9467889f3877dc50a97e80f124c50',
    'src/utils/html.ts': '8a965aafa5a6e49b6e84ee2782d3e6fd3100c7a7',
    'prisma/schema.prisma': '418abffcdf1a2403d895db4b8edecc3b2430b3bc',
    'package.json': 'e936cd213b47d5bac197487b9bde0dcb7477f9ae',
    'memory.md': '6f6e92413b94c1087d655621293720435cd67ef2',
}
BUSINESS_ADDENDUM = '''

## Approved business direction — on-demand sales demos (2026-09-07)

Steel Scale Systems owns and operates the demo engine for its own prospects and clients.
Do not build agency white-label resale, reseller billing, or an agency tenant hierarchy.
Lead scraping, enrichment, scoring, and normal outreach MUST NOT create demos, run demo
research, provision voice agents, or incur demo model/provider costs.

Demo creation is an explicit operator action: either enter business information manually
or prefill from an existing ProspectBusiness. A demo may exist without a prospect or Client.
Use website/GBP/niche/location/verified services and hours as available. Store private sales
notes separately from the public presentation. Never invent hours, pricing, reviews, audit
scores, local rankings, missed-lead counts, or revenue from a URL or niche alone.

Workflow: interested prospect -> Create Demo -> input/context -> draft generation ->
operator review -> explicit publish -> manually share link -> engagement -> sales call.
Production onboarding is a separate approved process; demo activity must never send real
SMS, place real calls, create live bookings, or automatically convert/create a Client.

The initial implementation package contains guided simulations, bounded homepage research,
ROI scenarios, optional prospect linking, review/publishing and engagement events.
Live browser voice, live AI chat, review automation, verified GBP enrichment, score/call-queue
integration and the client portal are separate remaining milestones, not completed features.
See docs/STEEL_SCALE_DEMO_ENGINE.md and docs/DEMO_ENGINE_ROLLOUT.md for the implementation
boundary, verification steps and rollout requirements. Keep DEMO_ENGINE_ENABLED=false until
migration, application integration and staging tests have passed.
'''

def blob_hash(content: bytes) -> str:
    return hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest()

def git(root: Path, *args: str) -> str:
    return subprocess.check_output(['git', '-C', str(root), *args], text=True, stderr=subprocess.STDOUT).strip()

def replace_once(content: str, before: str, after: str, label: str) -> str:
    if content.count(before) != 1:
        raise ValueError(f'{label}: expected integration anchor exactly once; refused to guess.')
    return content.replace(before, after, 1)

def plan(root: Path) -> dict[str, bytes]:
    changes: dict[str, bytes] = {}
    sources: dict[str, str] = {}
    for name, expected in EXPECTED.items():
        target = root / name
        if target.is_symlink(): raise ValueError(f'Refusing symlink: {name}')
        content = target.read_bytes()
        if blob_hash(content) != expected:
            raise ValueError(f'{name} differs from the inspected baseline. Have Codex adapt the integration to the new file; do not overwrite or reset it.')
        sources[name] = content.decode('utf-8')
    app = replace_once(sources['src/app.ts'], "import express from 'express';", "import express from 'express';\nimport { demoAdminRouter, demoPublicRouter } from './demo-engine/routes.js';", 'app import')
    # These routers own their body parsing/auth/error handling. Mount before request logging so
    # bearer demo URLs and private demo forms are not captured by the existing generic logger.
    app = replace_once(app, "app.disable('x-powered-by');", "app.disable('x-powered-by');\n// On-demand demo routers are isolated from production fulfillment and request-body logging.\napp.use('/admin/demos', demoAdminRouter);\napp.use('/demo', demoPublicRouter);", 'app mount')
    changes['src/app.ts'] = app.encode()
    html = replace_once(sources['src/utils/html.ts'], '<span class="utility">internal admin</span>', '<nav><a href="/admin/demos">Sales demos</a> · <span class="utility">internal admin</span></nav>', 'admin navigation')
    changes['src/utils/html.ts'] = html.encode()
    schema = replace_once(sources['prisma/schema.prisma'], 'model ProspectBusiness {', 'model ProspectBusiness {\n  salesDemos SalesDemo[]', 'optional prospect inverse')
    schema += '\n' + (PACKAGE / 'schema/demo-models.prisma').read_text()
    changes['prisma/schema.prisma'] = schema.encode()
    package = json.loads(sources['package.json'])
    if 'test:demos' in package.get('scripts', {}): raise ValueError('test:demos already exists.')
    package['scripts']['test:demos'] = 'tsx --test src/demo-engine/core.test.ts'
    changes['package.json'] = (json.dumps(package, indent=2) + '\n').encode()
    changes['memory.md'] = (sources['memory.md'].rstrip() + BUSINESS_ADDENDUM + '\n').encode()
    example = root / '.env.example'
    if example.exists():
        if example.is_symlink(): raise ValueError('Refusing .env.example symlink.')
        data = example.read_text()
        if 'DEMO_ENGINE_ENABLED=' in data: raise ValueError('Demo feature flag already exists; review manually.')
        changes['.env.example'] = (data.rstrip() + '\n\n# On-demand demo engine; enable only after staging verification.\nDEMO_ENGINE_ENABLED=false\n').encode()
    for source in sorted((PACKAGE / 'overlay').rglob('*')):
        if not source.is_file(): continue
        rel = str(source.relative_to(PACKAGE / 'overlay'))
        target = root / rel
        if target.exists(): raise ValueError(f'Refusing to overwrite existing new-module file: {rel}')
        changes[rel] = source.read_bytes()
    for name in changes:
        if not (root / name).resolve().is_relative_to(root): raise ValueError(f'Path outside repository: {name}')
    return changes

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repo', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    root = args.repo.resolve()
    try:
        remote = git(root, 'remote', 'get-url', 'origin').removesuffix('.git')
        if remote not in ['https://github.com/ckalpakis/SteelScaleSystem', 'git@github.com:ckalpakis/SteelScaleSystem']:
            raise ValueError('Expected ckalpakis/SteelScaleSystem as origin; refused to modify another repo.')
        if git(root, 'status', '--porcelain'):
            raise ValueError('Working tree must be clean. Preserve and commit/stash your work yourself first.')
        if args.apply and git(root, 'branch', '--show-current') in ['', 'main', 'master']:
            raise ValueError('Use a dedicated feature branch, not main/master or detached HEAD.')
        changes = plan(root)
        print('Planned source changes:')
        for name in changes: print('  ' + name)
        if not args.apply:
            print('\nDry run only. No files, databases, GitHub refs, or live services changed.')
            return 0
        originals = {name: (root / name).read_bytes() if (root / name).exists() else None for name in changes}
        written: list[str] = []
        try:
            for name, data in changes.items():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = target.with_name(target.name + '.demo-install-tmp')
                try:
                    with temporary.open('xb') as handle: handle.write(data)
                    os.replace(temporary, target)
                finally:
                    if temporary.exists(): temporary.unlink()
                written.append(name)
        except Exception:
            for name in reversed(written):
                target = root / name
                if originals[name] is None: target.unlink(missing_ok=True)
                else: target.write_bytes(originals[name])
            raise
        print('\nSource files written locally. Nothing committed, pushed, migrated, enabled, or deployed.')
        print('Next: follow docs/DEMO_ENGINE_ROLLOUT.md in a development/staging environment.')
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Installation stopped safely: {error}', file=sys.stderr)
        return 1

if __name__ == '__main__': raise SystemExit(main())
