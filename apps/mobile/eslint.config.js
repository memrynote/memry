// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config')
const expoConfig = require('eslint-config-expo/flat')

module.exports = defineConfig([
  expoConfig,
  {
    // The generated editor module is minified bundle text, not source anyone
    // edits. `editor-web` itself now lives in packages/ and lints there.
    ignores: ['dist/*', 'ios/*', 'android/*', '.expo/*', 'src/editor/generated/*']
  }
])
