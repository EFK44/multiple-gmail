import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// scripts/make-icons.mjs copies assets/icon/icon.svg; a changed master without a rerun leaves stale copies.
describe('app icon', () => {
  it('the wizard and the project site use the current icon.svg', () => {
    const master = readFileSync('assets/icon/icon.svg', 'utf8');
    expect(readFileSync('src/web/img/icon.svg', 'utf8')).toBe(master);
    expect(readFileSync('docs/icon.svg', 'utf8')).toBe(master);
  });
  it('icon.ico and icon.icns are well-formed', () => {
    const ico = readFileSync('assets/icon/icon.ico');
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(7);
    const icns = readFileSync('assets/icon/icon.icns');
    expect(icns.toString('ascii', 0, 4)).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
  });
});
