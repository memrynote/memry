// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config')
const expoConfig = require('eslint-config-expo/flat')

module.exports = defineConfig([
  expoConfig,
  {
    // `editor-web/dist` is vite output that the build script folds into a
    // generated module; the generated module itself is minified bundle text,
    // not source anyone edits.
    ignores: [
      'dist/*',
      'ios/*',
      'android/*',
      '.expo/*',
      'editor-web/dist/*',
      'src/editor/generated/*'
    ]
  }
])
