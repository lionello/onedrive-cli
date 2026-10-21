'use strict'

const assert = require('node:assert/strict')
const FS = require('node:fs')
const OS = require('node:os')
const Path = require('node:path')
const { after, before, beforeEach, describe, test } = require('node:test')
const fetch = require('node-fetch')
const {
    Auth,
    SCOPES,
    TokenStore,
    pkcePair,
    resolveSettings,
    startBrowserLogin,
    startDeviceLogin,
} = require('../lib/auth')
const { MockGraph, base64url } = require('./helpers/mock-graph')

let mock
let dir
let store

before(async () => {
    mock = await new MockGraph().start()
    Object.assign(process.env, mock.env())
})

after(() => mock.stop())

beforeEach(() => {
    dir = FS.mkdtempSync(Path.join(OS.tmpdir(), 'onedrive-auth-'))
    store = new TokenStore(Path.join(dir, 'token'))
    mock.tokenRequests.length = 0
})

// A token record as the login flows save it.
function record(overrides = {}) {
    const tokens = mock.issueTokens()
    return {
        version: 2,
        client_id: 'test-client',
        tenant: 'common',
        scope: SCOPES.readwrite,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + 3600 * 1000,
        ...overrides,
    }
}

describe('resolveSettings', () => {
    test('login options win over the environment', () => {
        const s = resolveSettings({
            clientId: 'from-option',
            tenant: 'contoso.com',
            readonly: true,
        })
        assert.deepEqual(s, {
            clientId: 'from-option',
            tenant: 'contoso.com',
            scope: SCOPES.readonly,
        })
    })

    test('the environment wins over the defaults', () => {
        process.env.ONEDRIVE_TENANT = 'organizations'
        try {
            const s = resolveSettings()
            assert.equal(s.clientId, 'test-client')
            assert.equal(s.tenant, 'organizations')
            assert.equal(s.scope, SCOPES.readwrite)
        } finally {
            delete process.env.ONEDRIVE_TENANT
        }
    })

    test('a missing client ID is explained, not sent to the server', () => {
        const saved = process.env.ONEDRIVE_CLIENT_ID
        delete process.env.ONEDRIVE_CLIENT_ID
        try {
            assert.throws(() => resolveSettings(), /ONEDRIVE_CLIENT_ID/)
        } finally {
            process.env.ONEDRIVE_CLIENT_ID = saved
        }
    })
})

describe('TokenStore', () => {
    test('a bare token from an older version reads as a legacy token', async () => {
        FS.writeFileSync(store.path, 'EwB4A8l6BAAU\n')
        assert.deepEqual(await store.read(), {
            access_token: 'EwB4A8l6BAAU',
            legacy: true,
        })
    })

    test('records round-trip as JSON', async () => {
        const r = record()
        await store.write(r)
        assert.deepEqual(await store.read(), r)
    })

    test(
        'the file is readable by its owner only',
        { skip: process.platform === 'win32' },
        async () => {
            await store.write(record())
            assert.equal(FS.statSync(store.path).mode & 0o777, 0o600)
        }
    )

    test('remove reports whether there was a token', async () => {
        await store.write(record())
        assert.equal(await store.remove(), true)
        assert.equal(await store.remove(), false)
    })
})

describe('Auth.accessToken', () => {
    test('a token that is still valid is used without a renewal', async () => {
        const r = record()
        await store.write(r)
        assert.equal(await new Auth(store).accessToken(), r.access_token)
        assert.deepEqual(mock.tokenRequests, [])
    })

    test('a token about to expire is renewed and the new one saved', async () => {
        const r = record({ expires_at: Date.now() + 60 * 1000 })
        await store.write(r)
        const token = await new Auth(store).accessToken()
        assert.notEqual(token, r.access_token)
        assert.deepEqual(mock.tokenRequests, ['refresh_token'])
        const saved = await store.read()
        assert.equal(saved.access_token, token)
        assert.notEqual(saved.refresh_token, r.refresh_token)
        assert.equal(saved.client_id, 'test-client')
        assert.ok(saved.expires_at > Date.now() + 30 * 60 * 1000)
    })

    test('concurrent requests share a single renewal', async () => {
        await store.write(record({ expires_at: 0 }))
        const auth = new Auth(store)
        const tokens = await Promise.all(
            Array.from({ length: 5 }, () => auth.accessToken())
        )
        assert.equal(new Set(tokens).size, 1)
        assert.deepEqual(mock.tokenRequests, ['refresh_token'])
    })

    test('forceRefresh renews even a valid token', async () => {
        const r = record()
        await store.write(r)
        const token = await new Auth(store).accessToken({ forceRefresh: true })
        assert.notEqual(token, r.access_token)
    })

    test('a rejected renewal surfaces as a 401', async () => {
        await store.write(
            record({ expires_at: 0, refresh_token: 'rt-revoked' })
        )
        await assert.rejects(new Auth(store).accessToken(), {
            statusCode: 401,
            code: 'invalid_grant',
        })
    })

    test('a legacy token is used as is and cannot be renewed', async () => {
        FS.writeFileSync(store.path, 'legacy-token')
        const auth = new Auth(store)
        assert.equal(await auth.accessToken(), 'legacy-token')
        assert.equal(await auth.canRefresh(), false)
    })
})

describe('browser sign-in', () => {
    test('PKCE pair: the challenge is the SHA-256 of the verifier', () => {
        const { verifier, challenge } = pkcePair()
        assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
        assert.equal(
            challenge,
            base64url(
                require('crypto').createHash('sha256').update(verifier).digest()
            )
        )
    })

    test('the loopback redirect completes the sign-in', async () => {
        const login = await startBrowserLogin(store, { readonly: true })
        const authorize = new URL(login.url)
        assert.equal(authorize.origin, mock.url)
        assert.equal(authorize.pathname, '/common/oauth2/v2.0/authorize')
        const q = authorize.searchParams
        assert.equal(q.get('response_type'), 'code')
        assert.equal(q.get('code_challenge_method'), 'S256')
        assert.equal(q.get('scope'), SCOPES.readonly)
        assert.match(q.get('redirect_uri'), /^http:\/\/localhost:\d+\/$/)

        // Play the browser: Microsoft redirects back with a code.
        mock.approveCode('code-1', q.get('code_challenge'))
        const back = new URL(q.get('redirect_uri'))
        back.searchParams.set('code', 'code-1')
        back.searchParams.set('state', q.get('state'))
        const page = await fetch(back.href.replace('localhost', '127.0.0.1'))
        assert.equal(page.status, 200)
        assert.match(await page.text(), /Signed in/)

        const saved = await login.wait
        assert.equal(saved.scope, SCOPES.readonly)
        assert.ok(saved.refresh_token)
        assert.deepEqual(await store.read(), saved)
    })

    test('a response with the wrong state is refused', async () => {
        const login = await startBrowserLogin(store)
        const q = new URL(login.url).searchParams
        const back = new URL(q.get('redirect_uri'))
        back.searchParams.set('code', 'code-2')
        back.searchParams.set('state', 'forged')
        const page = await fetch(back.href.replace('localhost', '127.0.0.1'))
        assert.equal(page.status, 400)
        login.cancel()
        assert.throws(() => FS.readFileSync(store.path), { code: 'ENOENT' })
    })

    test('a sign-in the user declines rejects with the reason', async () => {
        const login = await startBrowserLogin(store)
        const q = new URL(login.url).searchParams
        const back = new URL(q.get('redirect_uri'))
        back.searchParams.set('state', q.get('state'))
        back.searchParams.set('error', 'access_denied')
        back.searchParams.set('error_description', 'The user declined.')
        const [page] = await Promise.all([
            fetch(back.href.replace('localhost', '127.0.0.1')),
            assert.rejects(login.wait, { code: 'access_denied' }),
        ])
        assert.equal(page.status, 400)
    })
})

describe('device code sign-in', () => {
    test('polls until the user finishes, then saves the token', async () => {
        mock.devicePolls = 0
        mock.devicePendingPolls = 2
        const login = await startDeviceLogin(store)
        assert.equal(login.userCode, 'ABCD-1234')
        assert.equal(login.verificationUri, 'https://microsoft.com/devicelogin')
        const saved = await login.wait
        assert.deepEqual(await store.read(), saved)
        assert.equal(
            mock.tokenRequests.filter(g => g.endsWith(':device_code')).length,
            3
        )
    })

    test('cancel stops the polling', async () => {
        mock.devicePolls = 0
        mock.devicePendingPolls = Infinity
        const login = await startDeviceLogin(store)
        login.cancel()
        await assert.rejects(login.wait, { code: 'cancelled' })
    })
})
