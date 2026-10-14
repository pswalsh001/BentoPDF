// Pure rules used by the desktop wrapper's open and save handling.

export interface DesktopSource {
  id: number;
  name: string;
}

export type SaveDecision =
  | { mode: 'ask-overwrite'; source: DesktopSource }
  | { mode: 'save-as'; near: DesktopSource | null };

const EXTENSION_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  json: 'application/json',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  html: 'text/html',
  xml: 'application/xml',
  zip: 'application/zip',
  epub: 'application/epub+zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
};

const IMAGE_EXTENSIONS = Object.keys(EXTENSION_MIME).filter((ext) =>
  EXTENSION_MIME[ext].startsWith('image/')
);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Turns a file input's `accept` value into extensions for a native file
 * dialog. Returns an empty list (no filter) if any entry cannot be mapped, so
 * the dialog never hides a file the tool would have accepted.
 */
export function acceptToExtensions(accept: string): string[] {
  const extensions = new Set<string>();
  const entries = accept
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  for (const entry of entries) {
    if (entry.startsWith('.')) {
      extensions.add(entry.slice(1));
    } else if (entry === 'image/*') {
      IMAGE_EXTENSIONS.forEach((ext) => extensions.add(ext));
    } else {
      const matches = Object.keys(EXTENSION_MIME).filter(
        (ext) => EXTENSION_MIME[ext] === entry
      );
      if (matches.length === 0) return [];
      matches.forEach((ext) => extensions.add(ext));
    }
  }
  return [...extensions];
}

export function mimeFromName(name: string): string {
  return EXTENSION_MIME[extensionOf(name)] ?? '';
}

/**
 * Decides whether a finished result may replace the file it came from.
 * Overwrite is only offered for a PDF result whose source PDF is certain:
 * either the tool named it (`knownSource`, e.g. the editor's active tab) or
 * it is the only file opened. Anything else goes through a Save As dialog.
 */
export function chooseSaveMode(
  sources: DesktopSource[],
  blobType: string,
  filename: string,
  knownSource: DesktopSource | null = null
): SaveDecision {
  const resultIsPdf =
    blobType === 'application/pdf' ||
    (blobType === '' && extensionOf(filename) === 'pdf');
  const source = knownSource ?? (sources.length === 1 ? sources[0] : null);

  if (source && resultIsPdf && extensionOf(source.name) === 'pdf') {
    return { mode: 'ask-overwrite', source };
  }
  return {
    mode: 'save-as',
    near: knownSource ?? sources[sources.length - 1] ?? null,
  };
}
