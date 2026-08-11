import { VERSION } from '../../src/index';

describe('scaffold', () => {
  it('exposes a version constant', () => {
    expect(VERSION).toBe('0.0.0');
  });
});
