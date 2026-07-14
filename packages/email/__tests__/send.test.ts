import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Replace the Resend SDK wholesale — no network, no real key needed.
const sendMock = vi.fn();
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}));

beforeEach(() => {
  vi.resetModules(); // fresh config + client memoization per test
  sendMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dispatch', () => {
  it('no-ops (skipped) when RESEND_API_KEY is unset', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const { dispatch } = await import('../src/send.js');
    const res = await dispatch({ to: 'a@b.com', subject: 's', html: '<p>h</p>', text: 't' });
    expect(res).toEqual({ sent: false, skipped: true });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends via Resend when configured (from + replyTo passed through)', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_123');
    vi.stubEnv('EMAIL_FROM', 'MediaLocker <no-reply@medialocker.io>');
    sendMock.mockResolvedValue({ data: { id: 'abc' }, error: null });

    const { dispatch } = await import('../src/send.js');
    const res = await dispatch({
      to: 'a@b.com',
      subject: 's',
      html: '<p>h</p>',
      text: 't',
      replyTo: 'x@y.com',
    });

    expect(res.sent).toBe(true);
    expect(res.id).toBe('abc');
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'MediaLocker <no-reply@medialocker.io>',
        to: 'a@b.com',
        subject: 's',
        replyTo: 'x@y.com',
      }),
    );
  });

  it('returns an error (never throws) when Resend rejects', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_123');
    sendMock.mockResolvedValue({ data: null, error: { message: 'domain not verified' } });

    const { dispatch } = await import('../src/send.js');
    const res = await dispatch({ to: 'a@b.com', subject: 's', html: '<p>h</p>', text: 't' });

    expect(res.sent).toBe(false);
    expect(res.error).toContain('domain not verified');
  });

  it('returns an error (never throws) when the SDK throws', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_123');
    sendMock.mockRejectedValue(new Error('network down'));

    const { dispatch } = await import('../src/send.js');
    const res = await dispatch({ to: 'a@b.com', subject: 's', html: '<p>h</p>', text: 't' });

    expect(res.sent).toBe(false);
    expect(res.error).toContain('network down');
  });
});
