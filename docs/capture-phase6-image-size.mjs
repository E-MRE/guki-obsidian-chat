/**
 * Phase 6 task 3 probe: where does an `image` base64 block stop being accepted?
 *
 * PLAN says "no size ceiling, no media-type branching, no supported-format list of our own", but
 * that sentence was written about the **path** case, where `Read` decides what it can open and its
 * error is the honest place for a failure. When we build the content block ourselves we are the one
 * making the claim to the API, so the ceiling has to be measured rather than inherited.
 *
 * Sends one synthetic PNG per size through the **real** CLI over `--input-format stream-json`, the
 * same transport `claude-process.ts` uses, and prints what comes back. The PNGs are uniform random
 * noise so deflate cannot compress them: the byte size is the thing under test, and a solid-colour
 * image of the same dimensions would weigh a few kilobytes.
 *
 *   node docs/capture-phase6-image-size.mjs 8 5.5 4.8 4          # megabytes of PNG, largest first
 *
 * `cwd` is a throwaway temp directory, **not the vault**: run in the vault the SessionStart hooks
 * fire, which costs real money per call and would put the vault's memory into the output (trap 33).
 * Largest first, because a rejected request is refused before inference and is therefore the cheap
 * end of the ladder.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

const BINARY = '/Users/you/.local/bin/claude';
// Haiku, deliberately: the request-size limit is an API-level constraint on the content block, not
// a property of the model, and this ladder is several calls long.
const MODEL = 'claude-haiku-4-5-20251001';

let crcTable = null;
function crc32(buf) {
	if (!crcTable) {
		crcTable = [];
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c;
		}
	}
	let c = 0xffffffff;
	for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
	return c ^ 0xffffffff;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td) >>> 0);
	return Buffer.concat([len, td, crc]);
}

/** An incompressible RGB PNG of `w`x`h`, with one recognisable solid patch so a success is provable. */
function noisePng(w, h) {
	const stride = w * 3 + 1;
	const raw = Buffer.alloc(stride * h);
	for (let y = 0; y < h; y++) {
		const off = y * stride;
		raw[off] = 0;
		for (let x = 1; x < stride; x++) raw[off + x] = (Math.random() * 256) | 0;
	}
	// A solid green square in the middle: the model naming it is the evidence the image arrived,
	// where "it did not error" alone would also be true of an image that was silently dropped.
	const cx = (w / 2) | 0;
	const cy = (h / 2) | 0;
	const half = Math.min(120, (Math.min(w, h) / 4) | 0);
	for (let y = cy - half; y < cy + half; y++) {
		for (let x = cx - half; x < cx + half; x++) {
			const at = y * stride + 1 + x * 3;
			raw[at] = 0;
			raw[at + 1] = 200;
			raw[at + 2] = 0;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

function cleanEnv() {
	const env = { ...process.env };
	for (const k of Object.keys(env)) {
		if (/^(CLAUDE|CLAUDECODE|ANTHROPIC|AI_AGENT|HEADROOM)/.test(k)) delete env[k];
	}
	env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
	return env;
}

function ask(cwd, b64, mediaType) {
	return new Promise((resolve) => {
		const p = spawn(
			BINARY,
			['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', MODEL],
			{ cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] },
		);
		let out = '';
		let err = '';
		let answered = false;
		const finish = (o) => {
			if (answered) return;
			answered = true;
			try { p.kill(); } catch { /* already gone */ }
			resolve(o);
		};
		p.stdout.on('data', (d) => {
			out += d;
			const lines = out.split('\n');
			out = lines.pop();
			for (const l of lines) {
				if (!l.trim()) continue;
				let e;
				try { e = JSON.parse(l); } catch { continue; }
				if (e.type === 'result') {
					finish({ subtype: e.subtype, isError: e.is_error, text: String(e.result ?? '').slice(0, 400), stderr: err.slice(0, 600) });
				}
			}
		});
		p.stderr.on('data', (d) => { err += d; });
		p.on('exit', (code) => finish({ subtype: `EXIT ${code}`, isError: true, text: '', stderr: err.slice(0, 600) }));
		setTimeout(() => finish({ subtype: 'TIMEOUT', isError: true, text: '', stderr: err.slice(0, 600) }), 180000);

		p.stdin.write(
			JSON.stringify({
				type: 'user',
				message: {
					role: 'user',
					content: [
						{ type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
						{ type: 'text', text: 'There is one solid coloured square in the middle of this noise. Name its colour in one word. Do not use any tools.' },
					],
				},
			}) + '\n',
		);
	});
}

const megabytes = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
if (megabytes.length === 0) {
	console.error('usage: node docs/capture-phase6-image-size.mjs <MB> [<MB> ...]   (largest first)');
	process.exit(2);
}

const cwd = mkdtempSync(join(tmpdir(), 'guki-imgsize-'));
try {
	for (const mb of megabytes) {
		// raw scanline bytes ≈ w*h*3, and noise deflates to about that, so this lands within a few
		// percent of the requested size. The exact size is printed, not the requested one.
		const side = Math.round(Math.sqrt((mb * 1024 * 1024) / 3));
		const png = noisePng(side, side);
		const b64 = png.toString('base64');
		console.log(
			`\n=== ${side}x${side}  png=${png.length} B (${(png.length / 1048576).toFixed(2)} MiB)  base64=${b64.length} B (${(b64.length / 1048576).toFixed(2)} MiB) ===`,
		);
		const r = await ask(cwd, b64, 'image/png');
		console.log(`  subtype=${r.subtype} is_error=${r.isError}`);
		console.log(`  result=${JSON.stringify(r.text)}`);
		if (r.stderr.trim()) console.log(`  stderr=${JSON.stringify(r.stderr)}`);
	}
} finally {
	rmSync(cwd, { recursive: true, force: true });
}
