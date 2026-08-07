import yauzl from 'yauzl';
import { AppError } from '@comic/shared';

/**
 * Random-access reads into a CBZ.
 *
 * A comic archive is routinely 100-400 MB. Extracting one to a temp directory
 * to serve a single page would blow through disk and add latency to every
 * request, so we open the archive's central directory and stream just the
 * entry we need. yauzl's `lazyEntries` mode keeps this to one seek per read.
 */

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;

export interface ZipEntryInfo {
  readonly name: string;
  readonly uncompressedSize: number;
}

function openArchive(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) {
        reject(new AppError('UPSTREAM_MALFORMED', `cannot open archive: ${err?.message ?? 'unknown'}`));
        return;
      }
      resolve(zip);
    });
  });
}

/**
 * List image entries in reading order.
 *
 * Archives store entries in whatever order the packer emitted, which is often
 * not page order, so we sort by filename. A plain lexicographic sort puts
 * "page10" before "page2", so we compare with numeric collation.
 */
export async function listImageEntries(archivePath: string): Promise<ZipEntryInfo[]> {
  const zip = await openArchive(archivePath);
  const entries: ZipEntryInfo[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        // Skip directories, macOS resource forks, and non-images.
        const isDir = name.endsWith('/');
        const isJunk = name.startsWith('__MACOSX/') || name.split('/').pop()?.startsWith('.');
        if (!isDir && !isJunk && IMAGE_EXT.test(name)) {
          entries.push({ name, uncompressedSize: entry.uncompressedSize });
        }
        zip.readEntry();
      });
      zip.on('end', resolve);
      zip.on('error', (err: Error) =>
        reject(new AppError('UPSTREAM_MALFORMED', `archive read failed: ${err.message}`)),
      );
      zip.readEntry();
    });
  } finally {
    zip.close();
  }

  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  entries.sort((a, b) => collator.compare(a.name, b.name));
  return entries;
}

/** Read one entry fully into memory, refusing anything over `maxBytes`. */
export async function readZipEntry(
  archivePath: string,
  entryName: string,
  maxBytes: number,
): Promise<Buffer> {
  const zip = await openArchive(archivePath);

  try {
    return await new Promise<Buffer>((resolve, reject) => {
      let found = false;

      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== entryName) {
          zip.readEntry();
          return;
        }
        found = true;

        if (entry.uncompressedSize > maxBytes) {
          // Checked before decompressing so a zip bomb never gets expanded.
          reject(new AppError('UPSTREAM_MALFORMED', `archive entry exceeds the size limit`));
          return;
        }

        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) {
            reject(new AppError('UPSTREAM_MALFORMED', `cannot read entry: ${err?.message ?? '?'}`));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          stream.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
              stream.destroy();
              reject(new AppError('UPSTREAM_MALFORMED', 'archive entry exceeds the size limit'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('end', () => resolve(Buffer.concat(chunks)));
          stream.on('error', (e: Error) =>
            reject(new AppError('UPSTREAM_MALFORMED', `entry stream failed: ${e.message}`)),
          );
        });
      });

      zip.on('end', () => {
        if (!found) reject(new AppError('NOT_FOUND', `no entry "${entryName}" in archive`));
      });
      zip.on('error', (err: Error) =>
        reject(new AppError('UPSTREAM_MALFORMED', `archive read failed: ${err.message}`)),
      );
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}
