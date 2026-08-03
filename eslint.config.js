const js = require('@eslint/js')
const globals = require('globals')

// Flat config: ESLint 9 dropped .eslintrc.* support, and ESLint 10 no longer
// bundles @eslint/js or globals, so both are declared as devDependencies.
// Equivalent to the .eslintrc.js this replaces (eslint:recommended, es2018,
// node globals). bin/onedrive is listed explicitly: flat config only lints a
// file that some `files` pattern matches, and it has no .js extension.
module.exports = [
    js.configs.recommended,
    {
        files: ['**/*.js', 'bin/onedrive'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: globals.node,
        },
    },
]
