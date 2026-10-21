const js = require('@eslint/js')
const globals = require('globals')

// ESLint 9 dropped .eslintrc discovery, so this replaces the old
// .eslintrc.js. `bin/onedrive` has no .js extension, which no default
// pattern matches -- name it explicitly or `eslint bin/onedrive` finds no
// configuration and refuses to lint it.
module.exports = [
    js.configs.recommended,
    {
        files: ['bin/onedrive', 'lib/**/*.js', 'test/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: globals.node,
        },
    },
]
