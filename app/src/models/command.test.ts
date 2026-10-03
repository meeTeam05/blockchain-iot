import { parseCommand } from './command';

describe('parseCommand', () => {
  it('parses a full payload', () => {
    const command = parseCommand({
      id: 'c1',
      payload: { relay: 1 },
      status: 'pending',
      created_at: '2024-01-01T00:00:00Z',
      executed_at: null,
    });

    expect(command).toEqual({
      id: 'c1',
      payload: { relay: 1 },
      status: 'pending',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      executedAt: null,
    });
  });

  it('throws when created_at is missing', () => {
    expect(() => parseCommand({ id: 'c1', payload: {}, status: 'pending' })).toThrow();
  });
});
