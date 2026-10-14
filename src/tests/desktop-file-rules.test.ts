import { describe, it, expect } from 'vitest';
import {
  acceptToExtensions,
  mimeFromName,
  chooseSaveMode,
} from '@/js/utils/desktop-file-rules';

describe('acceptToExtensions', () => {
  it('should map a PDF mime type to its extension', () => {
    expect(acceptToExtensions('application/pdf')).toEqual(['pdf']);
  });

  it('should pass through dotted extensions without the dot', () => {
    expect(acceptToExtensions('.pdf, .PNG')).toEqual(['pdf', 'png']);
  });

  it('should expand an image wildcard to common image extensions', () => {
    const result = acceptToExtensions('image/*');
    expect(result).toContain('png');
    expect(result).toContain('jpg');
  });

  it('should not repeat an extension named twice', () => {
    expect(acceptToExtensions('application/pdf,.pdf')).toEqual(['pdf']);
  });

  it('should return no filter for an empty accept value', () => {
    expect(acceptToExtensions('')).toEqual([]);
  });

  it('should return no filter when any entry is unknown', () => {
    expect(acceptToExtensions('application/pdf,application/x-unknown')).toEqual(
      []
    );
  });
});

describe('mimeFromName', () => {
  it('should recognise a PDF regardless of case', () => {
    expect(mimeFromName('Form.PDF')).toBe('application/pdf');
  });

  it('should recognise common image types', () => {
    expect(mimeFromName('sig.png')).toBe('image/png');
    expect(mimeFromName('scan.jpeg')).toBe('image/jpeg');
  });

  it('should return an empty type for an unknown extension', () => {
    expect(mimeFromName('notes.xyz')).toBe('');
  });

  it('should return an empty type when there is no extension', () => {
    expect(mimeFromName('README')).toBe('');
  });
});

describe('chooseSaveMode', () => {
  const pdf = { id: 1, name: 'form.pdf' };
  const otherPdf = { id: 2, name: 'other.pdf' };
  const image = { id: 3, name: 'scan.png' };

  it('should offer overwrite for a PDF made from the one PDF opened', () => {
    expect(chooseSaveMode([pdf], 'application/pdf', 'form_signed.pdf')).toEqual(
      { mode: 'ask-overwrite', source: pdf }
    );
  });

  it('should judge the result by file name when the blob has no type', () => {
    expect(chooseSaveMode([pdf], '', 'form.pdf')).toEqual({
      mode: 'ask-overwrite',
      source: pdf,
    });
  });

  it('should not offer overwrite when two files were opened', () => {
    expect(
      chooseSaveMode([pdf, otherPdf], 'application/pdf', 'merged.pdf')
    ).toEqual({ mode: 'save-as', near: otherPdf });
  });

  it('should not offer overwrite when the result is not a PDF', () => {
    expect(chooseSaveMode([pdf], 'application/zip', 'pages.zip')).toEqual({
      mode: 'save-as',
      near: pdf,
    });
  });

  it('should not offer to overwrite a non-PDF source with a PDF', () => {
    expect(chooseSaveMode([image], 'application/pdf', 'scan.pdf')).toEqual({
      mode: 'save-as',
      near: image,
    });
  });

  it('should offer to overwrite the named source even among several', () => {
    expect(
      chooseSaveMode([pdf, otherPdf], 'application/pdf', 'other.pdf', otherPdf)
    ).toEqual({ mode: 'ask-overwrite', source: otherPdf });
  });

  it('should not overwrite a named source that is not a PDF', () => {
    expect(
      chooseSaveMode([pdf, image], 'application/pdf', 'scan.pdf', image)
    ).toEqual({ mode: 'save-as', near: image });
  });

  it('should not overwrite a named source with a non-PDF result', () => {
    expect(
      chooseSaveMode([pdf, otherPdf], 'application/zip', 'out.zip', otherPdf)
    ).toEqual({ mode: 'save-as', near: otherPdf });
  });

  it('should fall back to a plain save dialog when nothing was opened', () => {
    expect(chooseSaveMode([], 'application/pdf', 'new.pdf')).toEqual({
      mode: 'save-as',
      near: null,
    });
  });
});
