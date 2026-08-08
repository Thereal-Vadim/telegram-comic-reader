/**
 * Generates a small CBZ library so the app can be run and tested without
 * anyone having to supply their own comics.
 *
 * Dev/e2e only. Leave LOCAL_LIBRARY_DIR empty in normal Mini App runs so these
 * placeholder series (Orbital Mechanics, Signal Lost, The Cartographer) do not
 * appear on Home — the frontend also purges them from IndexedDB when the
 * `local` adapter is not on the home feed.
 *
 * Pages are drawn procedurally with sharp: a numbered panel grid, distinct
 * colour per chapter. That is enough to verify page ordering by eye and to
 * give the reader realistically sized images to decode, which a solid colour
 * would not (a flat fill compresses to almost nothing and hides any
 * decode-time problems).
 *
 *   pnpm --filter @comic/backend sample-library [targetDir]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';

const PAGE_WIDTH = 1200;
const PAGE_HEIGHT = 1800;

interface SeriesSpec {
  title: string;
  chapters: number;
  pagesPerChapter: number;
  hue: number;
}

const SERIES: SeriesSpec[] = [
  { title: 'The Cartographer', chapters: 3, pagesPerChapter: 8, hue: 210 },
  { title: 'Signal Lost', chapters: 2, pagesPerChapter: 6, hue: 340 },
  { title: 'Orbital Mechanics', chapters: 4, pagesPerChapter: 5, hue: 150 },
];

/** Render one page as a JPEG buffer. */
async function renderPage(
  seriesTitle: string,
  chapter: number,
  page: number,
  total: number,
  hue: number,
): Promise<Buffer> {
  const bg = `hsl(${hue}, 25%, ${92 - (page % 3) * 4}%)`;
  const ink = `hsl(${hue}, 60%, 25%)`;

  // An SVG is the least awkward way to get text and shapes into sharp without
  // a font-rendering dependency.
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}">
      <rect width="100%" height="100%" fill="${bg}"/>
      <rect x="60" y="60" width="${PAGE_WIDTH - 120}" height="${PAGE_HEIGHT - 120}"
            fill="none" stroke="${ink}" stroke-width="6"/>
      ${[0, 1, 2]
        .map(
          (row) => `
        <rect x="120" y="${200 + row * 500}" width="${PAGE_WIDTH - 240}" height="440"
              fill="hsl(${(hue + row * 40) % 360}, 40%, ${70 - row * 8}%)"
              stroke="${ink}" stroke-width="4"/>`,
        )
        .join('')}
      <text x="${PAGE_WIDTH / 2}" y="150" font-family="sans-serif" font-size="56"
            font-weight="bold" fill="${ink}" text-anchor="middle">${seriesTitle}</text>
      <text x="${PAGE_WIDTH / 2}" y="${PAGE_HEIGHT - 90}" font-family="sans-serif"
            font-size="72" font-weight="bold" fill="${ink}" text-anchor="middle">
        Ch. ${chapter} — Page ${page} of ${total}
      </text>
    </svg>`;

  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

/* -------------------------------------------------------------------------- */
/* Minimal zip writer                                                         */
/* -------------------------------------------------------------------------- */

interface ZipEntry {
  name: string;
  data: Buffer;
  crc: number;
  compressed: Buffer;
}

/**
 * Writes a store-or-deflate zip by hand.
 *
 * Pulling in an archiver dependency for a dev-only fixture script is not worth
 * it, and the format is small enough to emit directly. Only what a CBZ needs
 * is implemented: no zip64, no encryption, no directory entries.
 */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const entries: ZipEntry[] = files.map((f) => ({
    name: f.name,
    data: f.data,
    crc: crc32(f.data),
    // JPEGs are already compressed; deflate still shaves a little and keeps
    // the archive representative of a real CBZ.
    compressed: zlib.deflateRawSync(f.data, { level: 1 }),
  }));

  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    chunks.push(local, nameBuf, entry.compressed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); // central directory signature
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0, 14);
    dir.writeUInt32LE(entry.crc, 16);
    dir.writeUInt32LE(entry.compressed.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk number
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(offset, 42); // local header offset

    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + entry.compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

async function main(): Promise<void> {
  const target = path.resolve(process.argv[2] ?? path.join(process.cwd(), 'var/sample-library'));
  await fs.mkdir(target, { recursive: true });

  for (const series of SERIES) {
    const seriesDir = path.join(target, series.title);
    await fs.mkdir(seriesDir, { recursive: true });

    for (let chapter = 1; chapter <= series.chapters; chapter++) {
      const pages: { name: string; data: Buffer }[] = [];

      for (let page = 1; page <= series.pagesPerChapter; page++) {
        pages.push({
          // Zero-padded so a lexicographic sort and a numeric one agree, which
          // is what a well-formed CBZ does.
          name: `page-${String(page).padStart(3, '0')}.jpg`,
          data: await renderPage(series.title, chapter, page, series.pagesPerChapter, series.hue),
        });
      }

      const file = path.join(seriesDir, `Chapter ${String(chapter).padStart(2, '0')}.cbz`);
      await fs.writeFile(file, buildZip(pages));
      console.log(`wrote ${path.relative(process.cwd(), file)} (${pages.length} pages)`);
    }
  }

  console.log(`\nSample library ready at ${target}`);
  console.log(`Run the backend with LOCAL_LIBRARY_DIR="${target}"`);
}

main().catch((err: unknown) => {
  console.error('failed to build the sample library:', err);
  process.exit(1);
});
