// Synthetic, labelled-outside-the-image fixtures; no personal photos or external assets.
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const output = resolve(process.argv[2] ?? '.local/gemma-vision/fixtures');
await mkdir(output, { recursive: true });
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch(existsSync(chrome) ? { executablePath: chrome } : {});
try {
  const page = await browser.newPage();
  const generated = await page.evaluate(async () => {
    function canvas() {
      const node = document.createElement('canvas');
      node.width = 512; node.height = 384;
      return node;
    }
    function ellipse(ctx, x, y, rx, ry, fill) {
      ctx.fillStyle = fill; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    }
    function person(ctx, x, y, shirt) {
      ellipse(ctx, x + 4, y + 59, 18, 4, '#77674740');
      ellipse(ctx, x, y, 7, 8, '#b77e54');
      ctx.fillStyle = shirt; ctx.fillRect(x - 9, y + 10, 18, 26);
      ctx.strokeStyle = '#3a4144'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(x - 4, y + 36); ctx.lineTo(x - 8, y + 58); ctx.moveTo(x + 4, y + 36); ctx.lineTo(x + 9, y + 58); ctx.stroke();
    }
    function beach(people = 2, different = false) {
      const node = canvas(), ctx = node.getContext('2d');
      const sky = ctx.createLinearGradient(0, 0, 0, 240);
      sky.addColorStop(0, '#7dc5ef'); sky.addColorStop(1, '#d5edf2');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, 512, 384);
      ellipse(ctx, different ? 400 : 420, 62, 29, 29, '#ffe39a');
      ellipse(ctx, 90, 54, 48, 14, '#f5fcff'); ellipse(ctx, 126, 62, 40, 12, '#f5fcff');
      ctx.fillStyle = '#387fa1'; ctx.fillRect(0, different ? 135 : 161, 512, 223);
      for (let y = 180; y < 290; y += 17) {
        ctx.strokeStyle = '#b8dfd770'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(y % 31, y); ctx.bezierCurveTo(150, y - 9, 300, y + 8, 512, y); ctx.stroke();
      }
      ctx.fillStyle = '#e5cc99'; ctx.beginPath(); ctx.moveTo(0, different ? 225 : 265); ctx.quadraticCurveTo(230, 222, 512, different ? 280 : 246); ctx.lineTo(512, 384); ctx.lineTo(0, 384); ctx.fill();
      const x = different ? 380 : 115, y = different ? 220 : 235;
      ctx.strokeStyle = '#7e6249'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 105); ctx.stroke();
      ctx.fillStyle = different ? '#d77436' : '#c33232'; ctx.beginPath(); ctx.arc(x, y, 63, Math.PI, Math.PI * 2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff3d8'; ctx.beginPath(); ctx.moveTo(x, y - 63); ctx.quadraticCurveTo(x - 32, y - 30, x - 22, y); ctx.lineTo(x + 22, y); ctx.quadraticCurveTo(x + 32, y - 30, x, y - 63); ctx.fill();
      const boatX = different ? 65 : 330;
      ctx.fillStyle = '#735342'; ctx.beginPath(); ctx.moveTo(boatX - 28, 194); ctx.lineTo(boatX + 28, 194); ctx.lineTo(boatX + 16, 205); ctx.lineTo(boatX - 15, 205); ctx.fill();
      ctx.fillStyle = '#fff7e5'; ctx.beginPath(); ctx.moveTo(boatX, 142); ctx.lineTo(boatX, 191); ctx.lineTo(boatX + 34, 191); ctx.fill();
      for (let n = 0; n < people; n++) person(ctx, (different ? 90 : 270) + n * 37, 286 + (n % 2) * 5, n % 2 ? '#f0bd4e' : '#3b6c4f');
      return node;
    }
    function mountain() {
      const node = canvas(), ctx = node.getContext('2d');
      ctx.fillStyle = '#bdd8df'; ctx.fillRect(0, 0, 512, 384);
      ctx.fillStyle = '#78978d'; ctx.beginPath(); ctx.moveTo(0, 285); ctx.lineTo(150, 50); ctx.lineTo(310, 285); ctx.lineTo(410, 90); ctx.lineTo(512, 270); ctx.lineTo(512, 384); ctx.lineTo(0, 384); ctx.fill();
      ctx.fillStyle = '#f6f5e8'; ctx.beginPath(); ctx.moveTo(115, 105); ctx.lineTo(150, 50); ctx.lineTo(190, 110); ctx.lineTo(157, 93); ctx.lineTo(140, 113); ctx.fill();
      ctx.fillStyle = '#466b62'; ctx.fillRect(0, 280, 512, 104);
      ctx.fillStyle = '#a4764b'; ctx.fillRect(300, 243, 90, 71);
      ctx.fillStyle = '#5d493b'; ctx.beginPath(); ctx.moveTo(284, 245); ctx.lineTo(345, 198); ctx.lineTo(405, 245); ctx.fill();
      ctx.fillStyle = '#f5d98f'; ctx.fillRect(315, 261, 18, 18); ctx.fillRect(360, 261, 18, 18);
      for (const x of [80, 130, 450]) { ctx.fillStyle = '#684c36'; ctx.fillRect(x - 4, 250, 8, 90); ctx.fillStyle = '#254f41'; ctx.beginPath(); ctx.moveTo(x, 173); ctx.lineTo(x - 35, 288); ctx.lineTo(x + 35, 288); ctx.fill(); }
      return node;
    }
    function dhash(node) {
      const small = document.createElement('canvas'); small.width = 9; small.height = 8;
      const ctx = small.getContext('2d'); ctx.drawImage(node, 0, 0, 9, 8);
      const data = ctx.getImageData(0, 0, 9, 8).data;
      const light = index => data[index * 4] * .299 + data[index * 4 + 1] * .587 + data[index * 4 + 2] * .114;
      let bits = 0n;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | BigInt(light(y * 9 + x) > light(y * 9 + x + 1));
      return bits.toString(16).padStart(16, '0');
    }
    const base = beach();
    const crop = canvas(); crop.getContext('2d').drawImage(base, 20, 14, 472, 356, 0, 0, 512, 384);
    const inputs = [
      ['beach', base, 'image/png', { scene: 'beach', people: 2, umbrellaColor: 'red' }],
      ['jpeg_copy', base, 'image/jpeg', { scene: 'beach', people: 2, umbrellaColor: 'red' }],
      ['crop', crop, 'image/png', { scene: 'beach', people: 2, umbrellaColor: 'red' }],
      ['burst_changed_people', beach(3), 'image/png', { scene: 'beach', people: 3, umbrellaColor: 'red' }],
      ['different_beach', beach(2, true), 'image/png', { scene: 'beach', people: 2, umbrellaColor: 'orange' }],
      ['mountain', mountain(), 'image/png', { scene: 'mountain', people: 0, umbrellaColor: 'none' }],
      ['new_arrival', beach(1, true), 'image/png', { scene: 'beach', people: 1, umbrellaColor: 'orange' }],
    ];
    return await Promise.all(inputs.map(async ([id, node, mime, expected]) => {
      const data = node.toDataURL(mime, .72);
      const decoded = new Image(); decoded.src = data; await decoded.decode();
      const pixels = canvas(); pixels.getContext('2d').drawImage(decoded, 0, 0);
      return { id, mime, expected, dhash: dhash(pixels), data };
    }));
  });
  const images = [];
  for (const fixture of generated) {
    const bytes = Buffer.from(fixture.data.split(',')[1], 'base64');
    const path = `${fixture.id}.${fixture.mime === 'image/jpeg' ? 'jpg' : 'png'}`;
    await writeFile(join(output, path), bytes);
    images.push({ id: fixture.id, path, sha256: createHash('sha256').update(bytes).digest('hex'), dhash: fixture.dhash, expected: fixture.expected });
  }
  const pairs = [
    { a: 'beach', b: 'jpeg_copy', expected: 'same_photo' },
    { a: 'beach', b: 'crop', expected: 'same_photo' },
    { a: 'beach', b: 'burst_changed_people', expected: 'similar_scene' },
    { a: 'beach', b: 'different_beach', expected: 'different' },
    { a: 'beach', b: 'mountain', expected: 'different' },
  ];
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ description: 'Synthetic illustrations only; not a real travel-photo quality benchmark. different_beach shares semantic category but changes composition and is not the same shot.', images: images.slice(0, 6), pairs }, null, 2));
  await writeFile(join(output, 'incremental-manifest.json'), JSON.stringify({ description: 'Same six initial images plus one newly arriving image; tests cache reuse.', images, pairs }, null, 2));
  console.log(`Generated ${images.length} synthetic images (6 initial + 1 incremental) and ${pairs.length} pairs: ${output}`);
} finally { await browser.close(); }
