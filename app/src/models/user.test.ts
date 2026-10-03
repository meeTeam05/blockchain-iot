import { parseUser } from './user';

describe('parseUser', () => {
  it('parses and maps full_name to fullName', () => {
    const user = parseUser({ id: 'u1', email: 'a@b.com', full_name: 'A B' });
    expect(user).toEqual({ id: 'u1', email: 'a@b.com', fullName: 'A B' });
  });

  it('defaults fullName to null when absent', () => {
    const user = parseUser({ id: 'u1', email: 'a@b.com' });
    expect(user.fullName).toBeNull();
  });

  it('throws on missing required fields', () => {
    expect(() => parseUser({ id: 'u1' })).toThrow();
  });
});
