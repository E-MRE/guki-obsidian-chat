#!/usr/bin/env python3
"""Strip the host session's own context out of a raw CLI capture, in place.

Run this on every new `docs/capture-*.jsonl` before committing it.

A capture is taken by spawning the real CLI with a real vault as `cwd`, so that vault's
`SessionStart` hook fires and writes its output into the stream. That output is a verbatim
dump of the vault's companion-memory notes and its stored assistant memories — personal
profile material that has nothing to do with what the capture was taken for. `system/init`
then adds an inventory of the machine that took it: installed plugins, skills, slash
commands and local config paths. All of it is permanent once committed.

What is removed:
  - `system/hook_response` and `system/hook_progress`: the `output` and `stdout` strings.
  - `system/init`: `plugins`, `skills`, `slash_commands`, `memory_paths`.

What is deliberately kept:
  - `mcp_servers` in `system/init`. offline-checks.ts §K10 asserts on three named entries in
    it (`codebase-memory-mcp` connected, `claude.ai Focus MCP` needs-auth, `guki-perm`
    absent). Scrubbing it breaks the suite.
  - Every event's field set, id, ordering and `_t` offset, so the stream still replays
    identically. The line count does not change.
  - The model's own text, thinking blocks, tool calls, socket traffic and `result` events —
    the payload the 535 assertions actually replay. Left byte for byte.

Safe because `stream-reducer.ts` renders nothing for `hook_*` (see its `system/status,
hook_*, ...: nothing to render yet`), and no assertion reads the fields above. Verified on
2026-09-02 by running the suite before and after: 535 ok both times, output identical.

The check is deliberately **structural**, not a list of strings to look for. A blocklist of
personal terms would have to spell out the very facts it exists to remove, and would go
stale the moment the host session's context changed. Instead `--check` asks whether the
fields above are still carrying content, which is true of any capture from any machine.

`cwd` in `system/init` is left alone. It holds the vault path, which is a machine path
rather than vault content, and the same path is hard-coded in `src/constants.ts`
(`FALLBACK_VAULT_PATH`) and asserted in the Phase 6 `listSessions` criterion. Generalising
it is a code change, not a scrub.

Usage:
    python3 docs/scrub-capture.py docs/capture-phase7-whatever.jsonl [more.jsonl ...]
    python3 docs/scrub-capture.py --check docs/*.jsonl     # report only, exit 1 if dirty
"""
import json
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


def main(argv):
	check_only = '--check' in argv
	paths = [a for a in argv if not a.startswith('--')]
	if not paths:
		print(__doc__.strip().split('Usage:')[-1].strip(), file=sys.stderr)
		return 2

	dirty = False
	for path in paths:
		with open(path, 'rb') as handle:
			data = handle.read()

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
