/**
 * Set by the `[define]` tables in wrangler.toml: true for local dev, false
 * for staging and production. Left undefined (for example under vitest) it
 * counts as false.
 */
declare global {
  const __BASTION_LOCAL_DEV__: boolean | undefined;
}
export {};
