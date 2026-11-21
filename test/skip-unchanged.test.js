'use strict'

const assert = require('node:assert/strict')
const FS = require('node:fs')
const { beforeEach, describe, test } = require('node:test')
const { useCli } = require('./helpers/cli')
const { quickXorHash } = require('../lib/quickxorhash')

const cli = useCli()

beforeEach(() => {
    cli.mock.hashKind = 'quickXorHash'
})

const transfers = () =>
    cli.mock.requests.filter(r => /^(PUT|GET) .*\/content$/.test(r))

// Two different files of the same length and the same QuickXorHash: flipping
// the same bit in bytes 160 apart cancels out, as both land on the same bit
// of the 160-bit register.
function collidingPair() {
    const a = Buffer.alloc(400)
    for (let i = 0; i < a.length; i++) {
        a[i] = (i * 31 + 7) & 0xff
    }
    const b = Buffer.from(a)
    b[10] ^= 0x01
    b[170] ^= 0x01
    assert.equal(a.length, b.length)
    assert.notDeepEqual(a, b)
    assert.equal(quickXorHash(a), quickXorHash(b))
    return [a, b]
}

describe('skipping unchanged files (#36)', () => {
    test('an upload of identical content is skipped', async () => {
        FS.writeFileSync(cli.local('hello.txt'), 'hello world')
        const { code, stdout } = await cli.run('cp', './hello.txt', ':/')
        assert.equal(code, 0)
        assert.match(stdout, /\(unchanged\)/)
        assert.deepEqual(transfers(), [])
    })

    test('a different file still never overwrites', async () => {
        FS.writeFileSync(cli.local('hello.txt'), 'something else')
        const { code, stderr } = await cli.run('cp', './hello.txt', ':/')
        assert.equal(code, 1)
        assert.match(stderr, /already exists/)
        assert.equal(
            cli.mock.content.get('hello.txt').toString(),
            'hello world'
        )
    })

    test('items that only report sha1Hash are compared by SHA-1', async () => {
        cli.mock.hashKind = 'sha1Hash'
        FS.writeFileSync(cli.local('hello.txt'), 'hello world')
        const { code, stdout } = await cli.run('cp', './hello.txt', ':/')
        assert.equal(code, 0)
        assert.match(stdout, /\(unchanged\)/)
        assert.deepEqual(transfers(), [])
    })

    test('mv of identical content removes the local file', async () => {
        FS.writeFileSync(cli.local('hello.txt'), 'hello world')
        const { code } = await cli.run('mv', './hello.txt', ':/')
        assert.equal(code, 0)
        assert.equal(FS.existsSync(cli.local('hello.txt')), false)
        // Compared byte for byte (a download), never re-uploaded.
        assert.deepEqual(transfers(), [
            'GET /v1.0/me/drive/root:/hello.txt:/content',
        ])
        assert.equal(
            cli.mock.content.get('hello.txt').toString(),
            'hello world'
        )
    })

    test('a download over an identical local file is skipped', async () => {
        FS.writeFileSync(cli.local('hello.txt'), 'hello world')
        const before = FS.statSync(cli.local('hello.txt')).mtimeMs
        const { code, stdout } = await cli.run('cp', ':/hello.txt', './')
        assert.equal(code, 0)
        assert.match(stdout, /\(unchanged\)/)
        assert.deepEqual(transfers(), [])
        assert.equal(FS.statSync(cli.local('hello.txt')).mtimeMs, before)
    })

    test('a download over a different local file replaces it', async () => {
        FS.writeFileSync(cli.local('hello.txt'), 'old')
        const { code } = await cli.run('cp', ':/hello.txt', './')
        assert.equal(code, 0)
        assert.equal(
            FS.readFileSync(cli.local('hello.txt'), 'utf8'),
            'hello world'
        )
    })

    test('a new download costs no extra request', async () => {
        const { code } = await cli.run('cp', ':/hello.txt', './')
        assert.equal(code, 0)
        assert.deepEqual(
            cli.mock.requests.filter(r => r.startsWith('GET /v1.0/')),
            ['GET /v1.0/me/drive/root:/hello.txt:/content']
        )
    })

    test('mv to a colliding remote file keeps the local source', async () => {
        const [remote, local] = collidingPair()
        cli.mock.addFile('c.bin', remote)
        FS.writeFileSync(cli.local('c.bin'), local)
        const { stdout } = await cli.run('mv', './c.bin', ':/')
        assert.doesNotMatch(stdout, /\(unchanged\)/)
        assert.deepEqual(FS.readFileSync(cli.local('c.bin')), local)
        assert.deepEqual(cli.mock.content.get('c.bin'), remote)
    })

    test('mv from a remote file over a colliding local file transfers it', async () => {
        const [remote, local] = collidingPair()
        cli.mock.addFile('c.bin', remote)
        FS.writeFileSync(cli.local('c.bin'), local)
        const { code, stdout } = await cli.run('mv', ':/c.bin', './')
        assert.equal(code, 0)
        assert.doesNotMatch(stdout, /\(unchanged\)/)
        assert.deepEqual(FS.readFileSync(cli.local('c.bin')), remote)
        assert.equal(cli.mock.items.has('c.bin'), false)
    })

    test('mv keeps a remote source that changed during the move', async () => {
        cli.mock.afterDownload = path => cli.mock.addFile(path, 'changed')
        const { code, stderr } = await cli.run('mv', ':/hello.txt', './')
        assert.equal(code, 1)
        assert.match(stderr, /changed/)
        assert.equal(cli.mock.content.get('hello.txt').toString(), 'changed')
        assert.equal(
            FS.readFileSync(cli.local('hello.txt'), 'utf8'),
            'hello world'
        )
    })

    test('running cp -R again transfers nothing', async () => {
        FS.mkdirSync(cli.local('copy'))
        assert.equal(
            (await cli.run('cp', '-R', ':/Documents', './copy')).code,
            0
        )
        cli.mock.requests.length = 0
        const { code, stdout } = await cli.run(
            'cp',
            '-R',
            ':/Documents',
            './copy'
        )
        assert.equal(code, 0)
        assert.match(stdout, /\(unchanged\)/)
        assert.deepEqual(transfers(), [])
    })
})
