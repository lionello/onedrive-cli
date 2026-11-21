'use strict'

// Run by `npm publish` (prepublishOnly). Version 2 signs in through the
// Microsoft identity platform, which needs an application (client) ID. Until
// the project has registered one and set DEFAULT_CLIENT_ID in lib/auth.js,
// every user would have to register their own app, so such a build may only be
// published under a pre-release dist-tag (`npm publish --tag next`); `latest`
// keeps serving 1.x until a default exists. See "Upgrading from 1.x" in the
// README.

const { DEFAULT_CLIENT_ID } = require('../lib/auth')

const tag = process.env.npm_config_tag || 'latest'
if (!DEFAULT_CLIENT_ID && tag === 'latest') {
    console.error(
        'DEFAULT_CLIENT_ID in lib/auth.js is not set. Register the app and set ' +
            'it before publishing to "latest", or publish a pre-release with ' +
            '`npm publish --tag next`.'
    )
    process.exit(1)
}
