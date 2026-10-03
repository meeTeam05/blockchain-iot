import { parseHome, parseRoom } from './home';

describe('parseHome', () => {
  it('defaults timezone when absent', () => {
    const home = parseHome({ id: 'h1', name: 'My Home' });
    expect(home.timezone).toBe('Asia/Ho_Chi_Minh');
    expect(home.ownerId).toBeNull();
  });

  it('throws on missing required fields', () => {
    expect(() => parseHome({ name: 'My Home' })).toThrow();
  });
});

describe('parseRoom', () => {
  it('maps home_id to homeId', () => {
    const room = parseRoom({ id: 'r1', home_id: 'h1', name: 'Living Room' });
    expect(room).toEqual({ id: 'r1', homeId: 'h1', name: 'Living Room', icon: null });
  });
});
