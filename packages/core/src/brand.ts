// The one place the brand lives (design.md § Naming). The CLI package's `bin` key and the
// extension manifest must match; packages/cli/test/brand.test.ts guards both.
export const BRAND = "slopstash";

/** Title-case form for UI labels: the Marketplace display name and command category. */
export const BRAND_TITLE = "Slopstash";

/** Git filter driver name, as in `filter.<name>.clean` and `filter=<name>`. */
export const FILTER_DRIVER = BRAND;

/** Tracked sidecar folder; brand-independent so a rename never moves user data. */
export const SIDECAR_ROOT = ".agents/comments";

/** Tracked list of comments `scan` must not propose again; brand-independent like the sidecars. */
export const SCAN_IGNORE = ".agents/scan-ignore";
