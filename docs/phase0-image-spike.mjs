// Phase 0 spike 2: can an image be attached over --input-format stream-json?
// Renders a tiny PNG containing a recognisable shape, sends it as a base64
// image content block, and checks whether the model can describe it.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';

const CB = '/Users/you/.local/share/claude/versions/2.1.248';
const DIR = process.cwd();

// 200x200 PNG: solid red square, drawn via sips from a generated PPM would be
// fragile; instead use a hand-built minimal PNG through Node's zlib.
import zlib from 'node:zlib';
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = rgb[0];
      raw[off + 2 + x * 3] = rgb[1];
      raw[off + 3 + x * 3] = rgb[2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  let table = null;
  function crc32(buf) {
    if (!table) {
      table = [];
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
    }
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return c ^ 0xffffffff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

const buf = png(120, 120, [220, 30, 30]);
fs.writeFileSync(DIR + '/red.png', buf);
const b64 = buf.toString('base64');

const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (/^(CLAUDE|CLAUDECODE|ANTHROPIC|AI_AGENT|HEADROOM)/.test(k)) delete env[k];
}
env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
env.HOME = '/Users/you';

const p = spawn(CB, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
  '--verbose', '--model', 'claude-haiku-4-5-20251001'], { cwd: DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });

const msg = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
      { type: 'text', text: 'What single colour fills this image? Answer with one word. Do not use any tools.' }
    ]
  }
};
p.stdin.write(JSON.stringify(msg) + '\n');

let acc = '';
let sbuf = '';
p.stdout.on('data', d => {
  sbuf += d;
  const lines = sbuf.split('\n'); sbuf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    fs.appendFileSync(DIR + '/img.jsonl', l + '\n');
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'result') {
      console.log('RESULT', e.subtype, 'is_error=' + e.is_error);
      console.log('ANSWER:', JSON.stringify((e.result || '').slice(0, 200)));
      p.kill();
    }
  }
});
p.stderr.on('data', d => process.stderr.write('[err] ' + d));
p.on('exit', c => console.log('EXIT', c));
setTimeout(() => { console.log('TIMEOUT'); p.kill(); }, 90000);
