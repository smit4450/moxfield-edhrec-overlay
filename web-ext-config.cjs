/**
 * Shared config for `web-ext lint` and `web-ext build`.
 *
 * `tools/` holds development-only diagnostics and tests. They must not ship in
 * the packaged extension, and excluding them also keeps the test harness's
 * deliberate `eval` (it loads src/background.js under stubbed browser APIs) out
 * of the lint report, where it would otherwise read as a real finding.
 */
module.exports = {
  ignoreFiles: [
    'tools',
    'node_modules',
    // Listing assets are for AMO, not for the package: the screenshots alone
    // are several MB and would ship inside every install.
    'listing',
    'CLAUDE.md',
    '.github',
    '.editorconfig',
    // Playwright's persistent profile and screenshots: large, local-only, and
    // nothing to do with the shipped extension.
    '.pw-profile',
    '.pw-shots',
    'package.json',
    'package-lock.json',
    'web-ext-config.cjs',
    '.gitattributes',
    '.gitignore',
  ],
};
