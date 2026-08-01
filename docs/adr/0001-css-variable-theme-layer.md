# Themes are CSS variable overrides, not rule rewrites

The Modern/Classic UI toggle is implemented as a single `[data-ui="modern"]` CSS layer that only redefines CSS custom properties (plus one structural override for the chunks header blur). The Classic theme is the `:root` defaults — their values are preserved verbatim, pixel-identical to pre-theme releases, and can never leak into the modern theme, because overrides are scoped and variables are the only thing they change.

Note: introducing the variable layer required extracting a few hard-coded colors in each page's `:root` into variables (`--accent-rgb`, `--btn-primary-hover`, `--on-accent`, `--accent-gradient*`). The `:root` blocks were rewritten with unchanged values; only the definitions moved into variables, so Classic renders identically to the pre-theme CSS.

We rejected the previous approach of an additive override layer that restyled rules directly: it bled into the old theme, and the frosted-glass look it enabled (`backdrop-filter` on many surfaces) caused scroll lag on low-end hardware. Variable-only theming keeps render cost near zero — swapping a variable changes paint, never a new filter or composite pass.
