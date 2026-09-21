// The one place the working title lives (design.md § Naming). The CLI package's `bin`
// key must match; packages/cli/test/brand.test.ts guards that.
export const BRAND = "tildenote";

/** Git filter driver name, as in `filter.<name>.clean` and `filter=<name>`. */
export const FILTER_DRIVER = BRAND;

/** Tracked sidecar folder; brand-independent so a rename never moves user data. */
export const SIDECAR_ROOT = ".agents/comments";
