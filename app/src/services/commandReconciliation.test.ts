import { matchesReportedShadow, reconcileCommand } from './commandReconciliation';

const shadow = (reported: Record<string, unknown>) => ({ reported, desired: {}, updatedAt: null });

test('ai expectation matches only the reported ai_enabled boolean', () => {
  expect(matchesReportedShadow(shadow({ ai_enabled: true }), { kind: 'ai', state: true })).toBe(true);
  expect(matchesReportedShadow(shadow({ ai_enabled: false }), { kind: 'ai', state: true })).toBe(false);
  expect(matchesReportedShadow(shadow({}), { kind: 'ai', state: false })).toBe(false);
  expect(matchesReportedShadow(null, { kind: 'ai', state: true })).toBe(false);
});

test('done ai command is confirmed once the reported shadow matches', () => {
  const submittedAt = new Date();
  const command = { id: 'cmd-ai', status: 'done' };

  expect(
    reconcileCommand({ command, expected: { kind: 'ai', state: true }, reportedShadow: shadow({ ai_enabled: false }), submittedAt }),
  ).toEqual({ state: 'awaiting-reported-state', commandId: 'cmd-ai' });
  expect(
    reconcileCommand({ command, expected: { kind: 'ai', state: true }, reportedShadow: shadow({ ai_enabled: true }), submittedAt }),
  ).toEqual({ state: 'confirmed', commandId: 'cmd-ai' });
});

test('ai command rejected by firmware without AI resolves as failed', () => {
  expect(
    reconcileCommand({
      command: { id: 'cmd-ai', status: 'error' },
      expected: { kind: 'ai', state: true },
      reportedShadow: shadow({}),
      submittedAt: new Date(),
    }),
  ).toEqual({ state: 'failed', commandId: 'cmd-ai', errorMessage: null });
});
