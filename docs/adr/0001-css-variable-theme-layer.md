# Themes are CSS variable overrides, not rule rewrites

The Modern/Classic UI toggle is implemented as a single `[data-ui="modern"]` CSS layer that only redefines CSS custom properties (plus one structural override for the chunks header blur). The Classic theme is the `:root` defaults — the original CSS is untouched and can never leak into the modern theme, because overrides are scoped and variables are the only thing they change.

We rejected the previous approach of an additive override layer that restyled rules directly: it bled into the old theme, and the frosted-glass look it enabled (`backdrop-filter` on many surfaces) caused scroll lag on low-end hardware. Variable-only theming keeps render cost near zero — swapping a variable changes paint, never a new filter or composite pass.
