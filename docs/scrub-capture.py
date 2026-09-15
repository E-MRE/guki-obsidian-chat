#!/usr/bin/env python3
"""Strip the host session's own context out of a raw CLI capture, in place,
and audit committed prose documents for host-identifying content.

Run this on every new `docs/capture-*.jsonl` and committed `docs/*.md` before committing.

A capture is taken by spawning the real CLI with a real vault as `cwd`, so that vault's
`SessionStart` hook fires and writes its output into the stream. That output is a verbatim
dump of the vault's companion-memory notes and its stored assistant memories — personal
profile material that has nothing to do with what the capture was taken for. `system/init`
then adds an inventory of the machine that took it: installed plugins, skills, slash
commands and local config paths. All of it is permanent once committed.

What is removed from captures:
  - `system/hook_response` and `system/hook_progress`: the `output` and `stdout` strings.
  - `system/init`: `plugins`, `skills`, `slash_commands`, `memory_paths`, `tools`, `agents`,
    `messaging_socket_path`.

What is deliberately kept in captures:
  - `mcp_servers` in `system/init`. offline-checks.ts §K10 asserts on three named entries in
    it (`codebase-memory-mcp` connected, `claude.ai Focus MCP` needs-auth, `guki-perm`
    absent). Scrubbing it breaks the suite.
  - Every event's field set, id, ordering and `_t` offset, so the stream still replays
    identically. The line count does not change.
  - The model's own text, thinking blocks, tool calls, socket traffic and `result` events —
    the payload the assertions actually replay. Left byte for byte.

Safe because `stream-reducer.ts` renders nothing for `hook_*` (see its `system/status,
hook_*, ...: nothing to render yet`), and no assertion reads the fields above. Verified on
2026-09-02 by running the suite before and after: 535 ok both times, output identical.

The capture check is deliberately **structural**, not a list of strings to look for. A
blocklist of personal terms would have to spell out the very facts it exists to remove, and
would go stale the moment the host session's context changed. Instead `--check` asks whether
the fields above are still carrying content, which is true of any capture from any machine.

`cwd` in `system/init` IS scrubbed. It was left alone originally because the same path was
hard-coded in `src/constants.ts` as `FALLBACK_VAULT_PATH`, so redacting it here would only
have moved the leak. That constant was deleted on 2026-09-04 and nothing asserts the capture's
`cwd` value, so the exemption outlived its reason — and a later capture went out carrying a
real home directory under it. Structural, like every other field here: any capture from any
machine is flagged until `cwd` reads the placeholder.

Checking prose documents:
  Alongside the capture scrubber, this tool audits text documents (Markdown and any other
  prose) for host-identifying leaks. Unlike JSON captures, text files cannot be automatically
  rewritten: prose requires human-meaningful redaction placeholders (such as `~/.local/bin/claude`
  or generic slug tags) to preserve sentence flow and technical accuracy. A mechanical substitution
  would mangle narrative sentences. Therefore, text mode is strictly a CHECK: it reports the file,
  line number, and matching category, exiting non-zero when any leak is detected. It never prints
  the offending string to avoid propagating sensitive values to logs or screen output.

  Like the structural capture audit, what the text check looks for is derived dynamically from the
  running machine at execution time — the user's home directory prefix, login username, and the
  `-Users-...`-style project directory slug that CLI transcripts generate. It carries no hard-coded
  personal strings, preventing leaks of the very details it guards and remaining accurate across
  different developer machines.

Usage:
    python3 docs/scrub-capture.py docs/capture-phase7-whatever.jsonl [more.jsonl ...]
    python3 docs/scrub-capture.py --check docs/*.jsonl docs/*.md  # audit only, exit 1 if dirty
    python3 docs/scrub-capture.py --check docs/*.jsonl           # audit captures
    python3 docs/scrub-capture.py --check docs/*.md              # audit markdown
"""
import getpass
import json
import os
import re
import subprocess
import sys

PLACEHOLDER = (
	'[redacted: SessionStart hook output. The original was a verbatim dump of the capturing '
	'session\'s own context. Hook events are not rendered (stream-reducer.ts) and no '
	'assertion reads this field. See docs/scrub-capture.py.]'
)

# offline-checks.ts §K10 asserts on this list; it must survive untouched.
PRESERVE_IN_INIT = frozenset({'mcp_servers'})

INIT_REPLACEMENTS = {
	'plugins': [],
	'skills': ['example-skill'],
	'slash_commands': ['example-command'],
	'memory_paths': {'auto': '/redacted/memory/'},
	'tools': ['example-tool'],
	'agents': ['example-agent'],
	'messaging_socket_path': '/redacted/messaging.sock',
	'cwd': '/redacted/vault',
}

HOOK_SUBTYPES = ('hook_response', 'hook_progress')


def _needs_scrub(obj):
	"""Which fields on this event still carry host context. Empty list means clean."""
	if obj.get('type') != 'system':
		return []
	subtype = obj.get('subtype')
	dirty = []
	if subtype in HOOK_SUBTYPES:
		for field in ('output', 'stdout'):
			value = obj.get(field)
			if isinstance(value, str) and value and value != PLACEHOLDER:
				dirty.append(field)
	elif subtype == 'init':
		for field, replacement in INIT_REPLACEMENTS.items():
			assert field not in PRESERVE_IN_INIT, field
			if field in obj and obj[field] != replacement:
				dirty.append(field)
	return dirty


def scrub_line(line):
	"""Return (new_line, fields_changed). Non-JSON and clean lines pass through unchanged."""
	try:
		obj = json.loads(line)
	except json.JSONDecodeError:
		return line, 0
	dirty = _needs_scrub(obj)
	if not dirty:
		return line, 0
	for field in dirty:
		if obj.get('subtype') in HOOK_SUBTYPES:
			obj[field] = PLACEHOLDER
		else:
			obj[field] = INIT_REPLACEMENTS[field]
	# Compact separators, matching what the CLI writes.
	return json.dumps(obj, ensure_ascii=False, separators=(',', ':')), len(dirty)


def scrub(data: bytes):
	"""Scrub raw capture bytes. Returns (new_bytes, fields_changed)."""
	text = data.decode('utf-8')
	trailing_newline = text.endswith('\n')
	lines, total = [], 0
	for line in text.split('\n'):
		if not line.strip():
			lines.append(line)
			continue
		new_line, changed = scrub_line(line.rstrip('\n'))
		lines.append(new_line)
		total += changed
	result = '\n'.join(lines)
	if trailing_newline and not result.endswith('\n'):
		result += '\n'
	return result.encode('utf-8'), total


def audit(data: bytes):
	"""Fields still carrying host context, as a {subtype: [field, ...]} summary."""
	found = {}
	for line in data.decode('utf-8').split('\n'):
		if not line.strip():
			continue
		try:
			obj = json.loads(line)
		except json.JSONDecodeError:
			continue
		dirty = _needs_scrub(obj)
		if dirty:
			found.setdefault(obj.get('subtype'), set()).update(dirty)
	return {k: sorted(v) for k, v in found.items()}


def get_host_patterns():
	"""Derive host-identifying patterns dynamically from the running machine.

	Returns a dict of categories:
	  'home_dir': list of candidate home directory paths
	  'home_slug': list of candidate -Users-... style path slugs
	  'username': compiled regex matching the username as a discrete word token
	"""
	username = getpass.getuser()
	home = os.path.expanduser('~')
	real_home = os.path.realpath(home)

	home_slug = home.replace('/', '-')
	real_home_slug = real_home.replace('/', '-')

	patterns = {}

	home_candidates = {h for h in (home, real_home) if len(h) > 1}
	patterns['home_dir'] = sorted(home_candidates, key=len, reverse=True)

	slug_candidates = {s for s in (home_slug, real_home_slug) if len(s) > 1 and s != '-'}
	patterns['home_slug'] = sorted(slug_candidates, key=len, reverse=True)

	if len(username) >= 2:
		patterns['username'] = re.compile(rf'\b{re.escape(username)}\b', re.IGNORECASE)

	return patterns


def audit_text(data: bytes, patterns=None):
	"""Scan text bytes for host leaks. Returns list of (line_no, [category, ...])."""
	if patterns is None:
		patterns = get_host_patterns()
	text = data.decode('utf-8', errors='replace')
	violations = []
	for line_no, line in enumerate(text.splitlines(), 1):
		matched = set()
		for h in patterns.get('home_dir', []):
			if h.lower() in line.lower():
				matched.add('home_dir')
		for s in patterns.get('home_slug', []):
			if s.lower() in line.lower():
				matched.add('home_slug')
		u = patterns.get('username')
		if u and u.search(line):
			matched.add('username')
		if matched:
			violations.append((line_no, sorted(matched)))
	return violations


def is_gitignored(path: str) -> bool:
	"""Check whether a path within a git repo is ignored by git."""
	try:
		proc = subprocess.run(
			['git', 'check-ignore', '-q', path],
			stdout=subprocess.DEVNULL,
			stderr=subprocess.DEVNULL,
		)
		return proc.returncode == 0
	except Exception:
		return False


def is_text_path(path: str) -> bool:
	"""Return True if path should be treated as text prose rather than capture jsonl."""
	return not path.endswith('.jsonl')


def main(argv):
	check_only = '--check' in argv
	include_ignored = '--include-ignored' in argv
	paths = [a for a in argv if not a.startswith('--')]
	if not paths:
		print(__doc__.strip().split('Usage:')[-1].strip(), file=sys.stderr)
		return 2

	patterns = get_host_patterns()
	dirty = False
	for path in paths:
		# If path is inside a git repo and ignored, report as skipped during check unless --include-ignored
		if check_only and not include_ignored and is_gitignored(path):
			print(f'{path}: skipped')
			continue

		try:
			with open(path, 'rb') as handle:
				data = handle.read()
		except OSError as err:
			print(f'{path}: ERROR — {err}', file=sys.stderr)
			dirty = True
			continue

		if is_text_path(path):
			if not check_only:
				print(
					f'{path}: text files cannot be automatically scrubbed; '
					'prose requires manual redaction. Use --check to audit.',
					file=sys.stderr,
				)
				dirty = True
				continue

			violations = audit_text(data, patterns)
			if violations:
				dirty = True
				for line_no, cats in violations:
					print(f'{path}:{line_no}: {", ".join(cats)}')
			else:
				print(f'{path}: clean')
			continue

		# .jsonl capture handling
		if check_only:
			found = audit(data)
			if found:
				dirty = True
				detail = '; '.join(f'{k}: {", ".join(v)}' for k, v in sorted(found.items()))
				print(f'{path}: DIRTY — {detail}')
			else:
				print(f'{path}: clean')
			continue

		new, changed = scrub(data)
		# A scrub that leaves a dirty field behind means the content moved somewhere this
		# script does not look. Fail loudly rather than write a file that looks cleaned.
		remaining = audit(new)
		if remaining:
			print(f'{path}: FAILED — still dirty after scrub: {remaining}', file=sys.stderr)
			dirty = True
			continue
		if changed:
			with open(path, 'wb') as handle:
				handle.write(new)
		print(f'{path}: {changed} fields redacted, {len(data)} -> {len(new)} bytes')

	return 1 if dirty else 0


if __name__ == '__main__':
	sys.exit(main(sys.argv[1:]))
