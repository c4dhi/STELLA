/**
 * A persona snapshot in agentConfig is a record of a past deployment, not a
 * request for today's default (#467).
 *
 * agentConfig is frozen at deploy: a restart or an auto-pause wake replays it
 * verbatim. Neither path carries a personaId — the wake reads only
 * session.lastAgentConfig — so resolving the default unconditionally silently
 * overwrote the snapshot, and an agent deployed as Grace came back as STELLA.
 */
describe('persona snapshot preservation on replay', () => {
  /** The exact guard from AgentsService.applyScopedConfiguration. */
  async function applyPersona(
    agentConfig: Record<string, unknown>,
    personaId: string | undefined,
    resolve: (id?: string) => Promise<Record<string, unknown> | null>,
  ) {
    if (!agentConfig.persona) {
      const persona = await resolve(personaId);
      if (persona) agentConfig.persona = persona;
    }
  }

  const GRACE = { id: 'p-grace', name: 'Grace', system_prompt: 'You are Grace.' };
  const DEFAULT = { id: 'p-default', name: 'STELLA', is_system_default: true };

  it('keeps the deployed persona when a wake replays the snapshot', async () => {
    const config: Record<string, unknown> = { persona: GRACE, plan: {} };
    const resolve = jest.fn().mockResolvedValue(DEFAULT);

    await applyPersona(config, undefined, resolve);

    expect(config.persona).toBe(GRACE);
    // Not merely overwritten-and-restored: the lookup must not happen at all,
    // or a deleted persona would fail the wake of a session that never needed it.
    expect(resolve).not.toHaveBeenCalled();
  });

  it('resolves the default on a fresh deploy with no persona chosen', async () => {
    const config: Record<string, unknown> = {};
    const resolve = jest.fn().mockResolvedValue(DEFAULT);

    await applyPersona(config, undefined, resolve);

    expect(config.persona).toBe(DEFAULT);
  });

  it('resolves the chosen persona on a fresh deploy', async () => {
    const config: Record<string, unknown> = {};
    const resolve = jest.fn().mockResolvedValue(GRACE);

    await applyPersona(config, 'p-grace', resolve);

    expect(resolve).toHaveBeenCalledWith('p-grace');
    expect(config.persona).toBe(GRACE);
  });

  it('leaves the config alone when nothing resolves', async () => {
    const config: Record<string, unknown> = {};
    await applyPersona(config, undefined, async () => null);
    expect(config.persona).toBeUndefined();
  });
});
