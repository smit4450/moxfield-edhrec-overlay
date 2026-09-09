/**
 * Shared config for `web-ext lint` and `web-ext build`.
 *
 * `tools/` holds development-only diagnostics and tests. They must not ship in
 * the packaged extension, and excluding them also keeps the test harness's
 * deliberate `eval` (it loads src/background.js under stubbed browser APIs) out
 * of the lint report, where it would otherwise read as a real finding.
 */
module.exports = {
  ignoreFiles: ['tools', 'web-ext-config.cjs', '.gitattributes', '.gitignore'],
};
