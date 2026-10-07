export const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `condition` every `every` ms until it holds, and throws `timed out waiting for <what>` after `timeout` ms. */
export async function waitFor(
  what: string,
  condition: () => boolean | Promise<boolean>,
  { timeout = 10_000, every = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle(every);
  }
}
