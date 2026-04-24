import { describe, expect, it } from 'bun:test';
import { parseUploadErrorMessage, toUploadProgress, uploadButtonLabel } from './upload-progress';

describe('upload progress helpers', () => {
  it('builds progress state from computable progress events', () => {
    const mockedEvent = {
      lengthComputable: true,
      loaded: 50,
      total: 100,
    };

    const progress = toUploadProgress(mockedEvent, 2, 3);
    expect(progress).toEqual({
      current: 2,
      total: 3,
      percent: 50,
    });
  });

  it('ignores non-computable progress events', () => {
    const mockedEvent = {
      lengthComputable: false,
      loaded: 10,
      total: 100,
    };

    expect(toUploadProgress(mockedEvent, 1, 1)).toBeNull();
  });

  it('formats the upload button label', () => {
    expect(uploadButtonLabel(null)).toBe('Upload');
    expect(uploadButtonLabel({ current: 1, total: 4, percent: 25 })).toBe('1/4 · 25%');
  });

  it('extracts upload error messages from json or text', () => {
    expect(parseUploadErrorMessage('{"error":"too large"}')).toBe('too large');
    expect(parseUploadErrorMessage('proxy timeout')).toBe('proxy timeout');
    expect(parseUploadErrorMessage('')).toBe('Upload failed');
  });
});
