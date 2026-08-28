#!/usr/bin/env node
// Lint the theme CSS layer. Any selector prefixed with [data-ui="modern"] or
// [data-ui="classic"] must contain only CSS custom property assignments
// (declarations whose property starts with `--`). The rule enforces
// ADR-0001: the theme layer is variable-only, with documented exceptions
// marked inline with a disable comment.
//
// CSS scope: this script reads the flat CSS in ui-theme.css and the inline
// `<style>` blocks in options.html and chunks.html. It does NOT parse nested
// at-rules; if a future selector appears inside a `@media` or `@supports`,
// add a small postcss-based pass then. The current theme layer is flat.
//
// Usage: node scripts/lint-theme-css.js

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const RULE_NAME = 'webnovel/no-structural-overrides-in-theme';
const THEME_SELECTOR = /\[data-ui=["'](?:modern|classic)["']\]/;
const FILES = [
  path.join(REPO_ROOT, 'ui-theme.css'),
  path.join(REPO_ROOT, 'options.html'),
  path.join(REPO_ROOT, 'chunks.html'),
];

function extractCss(filePath, content) {
  if (filePath.endsWith('.css')) return content;
  const blocks = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = re.exec(content)) !== null) blocks.push(m[1]);
  return blocks.join('\n');
}

// Match each `selector { body }` block at the top level. The body cannot
// contain `{` or `}` — sufficient for this project's flat CSS.
function findRules(css) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    rules.push({ selector: m[1].trim(), body: m[2], raw: m[0] });
  }
  return rules;
}

function isExempt(rule) {
  // Documented exception: a /* stylelint-disable ... RULE_NAME ... */ comment
  // anywhere in the rule. The comment is the escape hatch — paired with an
  // ADR reference, it makes the exception greppable.
  return new RegExp(
    String.raw`/\*\s*stylelint-disable[^*]*` + RULE_NAME.replace('/', '\\/') + String.raw`[^*]*\*/`,
  ).test(rule.raw);
}

function isThemeSelector(selector) {
  return THEME_SELECTOR.test(selector);
}

function isCustomProperty(prop) {
  return prop.trim().startsWith('--');
}

function findViolations(rule) {
  if (!isThemeSelector(rule.selector)) return [];
  if (isExempt(rule)) return [];
  const violations = [];
  for (const decl of rule.body.split(';')) {
    const propMatch = decl.match(/^\s*(--?[a-zA-Z][\w-]*)\s*:/);
    if (!propMatch) continue;
    if (!isCustomProperty(propMatch[1])) {
      violations.push({ selector: rule.selector, prop: propMatch[1] });
    }
  }
  return violations;
}

let totalViolations = 0;
for (const file of FILES) {
  const content = fs.readFileSync(file, 'utf8');
  const css = extractCss(file, content);
  for (const rule of findRules(css)) {
    for (const v of findViolations(rule)) {
      console.error(
        `${path.relative(REPO_ROOT, file)}: selector "${v.selector}" has ` +
        `non-custom-property declaration "${v.prop}". Theme-layer rules may ` +
        `only contain CSS custom property assignments. For a documented ` +
        `exception, add /* stylelint-disable-next-line ${RULE_NAME} */ ` +
        `with a reference to the ADR.`,
      );
      totalViolations++;
    }
  }
}

if (totalViolations > 0) {
  console.error(`\n✖ ${totalViolations} violation(s) in theme-layer CSS.`);
  process.exit(1);
} else {
  console.log('✓ Theme-layer CSS: all rules are pure custom-property assignments.');
}
