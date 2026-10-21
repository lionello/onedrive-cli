'use strict'

// End-to-end: run bin/onedrive against the mock Graph server.

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const FS = require('node:fs')
const OS = require('node:os')
const Path = require('node:path')
const { after, before, beforeEach, describe, test } = require('node:test')
const { SCOPES, TokenStore } = require('../lib/auth')
const { MockGraph } = require('./helpers/mock-graph')

const BIN = Path.join(__dirname, '..', 'bin', 'onedrive')

let mock
let home // $XDG_STATE_HOME, where the token lives
let cwd // working directory for local files
let tokenStore

function run(...args) {
    return new Promise(resolve => {
        execFile(
            process.execPath,
            [BIN, ...args],
            {
                cwd,
                env: {
                    PATH: process.env.PATH,
                    XDG_STATE_HOME: home,
                    ...mock.env(),
                },
            },
            (err, stdout, stderr) =>
                resolve({ code: err ? err.code : 0, stdout, stderr })
        )
    })
}

async function signIn(overrides = {}) {
    const tokens = mock.issueTokens()
    const record = {
        version: 2,
        client_id: 'test-client',
        tenant: 'common',
        scope: SCOPES.readwrite,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + 3600 * 1000,
        ...overrides,
    }
    await tokenStore.write(record)
    return record
}

before(async () => {
    mock = await new MockGraph().start()
})

after(() => mock.stop())

beforeEach(async () => {
    home = FS.mkdtempSync(Path.join(OS.tmpdir(), 'onedrive-home-'))
    cwd = FS.mkdtempSync(Path.join(OS.tmpdir(), 'onedrive-cwd-'))
    tokenStore = new TokenStore(Path.join(home, '.onedrive-cli-token'))
    mock.items.clear()
    mock.content.clear()
    mock.addFolder('')
        .addFolder('Documents')
        .addFolder('My Files')
        .addFile('hello.txt', 'hello world')
        .addFile('Documents/report one.txt', "it's a report")
    mock.requests.length = 0
    mock.tokenRequests.length = 0
    mock.corruptUploadHash = false
})

describe('reading', () => {
    test('ls lists the drive root', async () => {
        await signIn()
        const { code, stdout } = await run('ls')
        assert.equal(code, 0)
        assert.match(stdout, /Test User\s+11 .* hello\.txt/)
        assert.match(stdout, /Documents\//)
        assert.ok(mock.requests.includes('GET /v1.0/me/drive/root/children'))
    })

    test('stat addresses a path with spaces', async () => {
        await signIn()
        const { code, stdout } = await run('stat', ':/Documents/report one.txt')
        assert.equal(code, 0)
        assert.equal(JSON.parse(stdout).name, 'report one.txt')
        assert.ok(
            mock.requests.includes(
                'GET /v1.0/me/drive/root:/Documents/report one.txt:'
            )
        )
    })

    test('cat follows the download redirect', async () => {
        await signIn()
        const { code, stdout } = await run('cat', ':/hello.txt')
        assert.equal(code, 0)
        assert.equal(stdout, 'hello world')
    })

    test('find prints full paths', async () => {
        await signIn()
        const { stdout } = await run('find', ':/', '-name', '*.txt')
        assert.deepEqual(stdout.trim().split('\n').sort(), [
            ':/Documents/report one.txt',
            ':/hello.txt',
        ])
    })

    test('grep quotes the query as an OData string', async () => {
        await signIn()
        const { code, stdout } = await run('grep', "it's")
        assert.equal(code, 0)
        assert.ok(
            mock.requests.includes("GET /v1.0/me/drive/root/search(q='it''s')")
        )
        assert.equal(stdout, '')
    })

    test('df shows the drive quota', async () => {
        await signIn()
        const { code, stdout } = await run('df')
        assert.equal(code, 0)
        assert.match(stdout, /drive1 .* normal/)
    })
})

describe('copying and moving', () => {
    test('cp downloads a file', async () => {
        await signIn()
        const { code } = await run('cp', ':/hello.txt', './')
        assert.equal(code, 0)
        assert.equal(
            FS.readFileSync(Path.join(cwd, 'hello.txt'), 'utf8'),
            'hello world'
        )
    })

    test('cp uploads a file and checks its quickXorHash', async () => {
        await signIn()
        FS.writeFileSync(Path.join(cwd, 'new.txt'), 'fresh content')
        const { code, stdout } = await run('cp', './new.txt', ':/Documents/')
        assert.equal(code, 0, stdout)
        assert.equal(
            mock.content.get('Documents/new.txt').toString(),
            'fresh content'
        )
    })

    test('an upload whose hash does not match fails', async () => {
        await signIn()
        mock.corruptUploadHash = true
        FS.writeFileSync(Path.join(cwd, 'new.txt'), 'fresh content')
        const { code, stderr } = await run('cp', './new.txt', ':/')
        assert.equal(code, 1)
        assert.match(stderr, /quickXorHash mismatch/)
    })

    test('an upload never overwrites an existing file', async () => {
        await signIn()
        FS.writeFileSync(Path.join(cwd, 'hello.txt'), 'other content')
        const { code, stderr } = await run('cp', './hello.txt', ':/')
        assert.equal(code, 1)
        assert.match(stderr, /already exists/)
        assert.equal(mock.content.get('hello.txt').toString(), 'hello world')
    })

    test('a missing local file is not mistaken for a missing sign-in', async () => {
        await signIn()
        const { code, stderr } = await run('cp', './absent.txt', ':/')
        assert.equal(code, 1)
        assert.match(stderr, /ENOENT/)
        assert.doesNotMatch(stderr, /not logged in/)
    })

    test('mv moves into a folder whose name has a space (#71)', async () => {
        await signIn()
        const { code } = await run('mv', ':/hello.txt', ':/My Files/')
        assert.equal(code, 0)
        assert.ok(mock.items.has('My Files/hello.txt'))
        assert.ok(!mock.items.has('hello.txt'))
    })
})

describe('staying signed in', () => {
    test('an expired access token is renewed before the request', async () => {
        const before = await signIn({ expires_at: 0 })
        const { code } = await run('ls')
        assert.equal(code, 0)
        assert.deepEqual(mock.tokenRequests, ['refresh_token'])
        const after = await tokenStore.read()
        assert.notEqual(after.access_token, before.access_token)
    })

    test('a 401 is answered with one renewal and a retry', async () => {
        await signIn()
        mock.revokeAccessTokens()
        const { code } = await run('ls')
        assert.equal(code, 0)
        assert.deepEqual(mock.tokenRequests, ['refresh_token'])
    })

    test('a sign-in that cannot be renewed asks for a new login', async () => {
        await signIn({ expires_at: 0, refresh_token: 'rt-revoked' })
        const { code, stderr } = await run('ls')
        assert.equal(code, 255)
        assert.match(stderr, /login' to sign in/)
    })

    test('a legacy token that Graph rejects asks for a new login', async () => {
        await tokenStore.write('old-classic-token')
        const { code, stderr } = await run('ls')
        assert.equal(code, 255)
        assert.match(stderr, /old OneDrive API/)
    })

    test('without a token, the user is told to log in', async () => {
        const { code, stderr } = await run('ls')
        assert.equal(code, 255)
        assert.match(stderr, /not logged in/)
    })
})

describe('login and logout', () => {
    test('without a terminal, login uses a device code', async () => {
        mock.devicePolls = 0
        mock.devicePendingPolls = 1
        const { code, stdout } = await run('login', '--tenant', 'contoso.com')
        assert.equal(code, 0, stdout)
        assert.match(stdout, /enter the code ABCD-1234/)
        assert.match(stdout, /Signed in\./)
        const saved = await tokenStore.read()
        assert.equal(saved.tenant, 'contoso.com')
        assert.ok(saved.refresh_token)
        assert.ok(
            mock.requests.includes('POST /contoso.com/oauth2/v2.0/devicecode')
        )
    })

    test('login -r asks for read-only access', async () => {
        mock.devicePolls = 0
        const { code, stdout } = await run('login', '-r', '--device')
        assert.equal(code, 0)
        assert.match(stdout, /Signed in read-only\./)
        assert.equal((await tokenStore.read()).scope, SCOPES.readonly)
    })

    test('login with a token saves it as is', async () => {
        const { code, stdout } = await run('login', 'pasted-token')
        assert.equal(code, 0)
        assert.match(stdout, /Access token was saved/)
        assert.deepEqual(await tokenStore.read(), {
            access_token: 'pasted-token',
            legacy: true,
        })
    })

    test('logout removes the token', async () => {
        await signIn()
        assert.match((await run('logout')).stdout, /Signed out/)
        assert.match((await run('logout')).stdout, /Not signed in/)
    })
})
