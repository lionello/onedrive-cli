'use strict'

const assert = require('node:assert/strict')
const FS = require('node:fs')
const { describe, test } = require('node:test')
const { useCli } = require('./helpers/cli')

const cli = useCli()

const MiB = 1024 * 1024
const CHUNK = 10 * MiB

// 25 MiB that isn't all one byte, so a misplaced chunk changes the hash.
function bigFile(name, size = 25 * MiB) {
    const data = Buffer.alloc(size)
    for (let i = 0; i < size; i += 4) {
        data.writeUInt32LE(i, i)
    }
    FS.writeFileSync(cli.local(name), data)
    return data
}

const simplePuts = () =>
    cli.mock.requests.filter(r => r.startsWith('PUT /v1.0/'))

describe('upload sessions (#33)', () => {
    test('a large file goes up in 10 MiB chunks and is verified', async () => {
        const data = bigFile('big.bin')
        const { code, stdout } = await cli.run('cp', './big.bin', ':/big.bin')
        assert.equal(code, 0, stdout)
        assert.ok(cli.mock.content.get('big.bin').equals(data))
        assert.deepEqual(
            cli.mock.uploadChunks.map(c => c.length),
            [CHUNK, CHUNK, 5 * MiB]
        )
        assert.deepEqual(simplePuts(), [])
        assert.ok(
            cli.mock.requests.includes(
                'POST /v1.0/me/drive/root:/big.bin:/createUploadSession'
            )
        )
    })

    test('a small file still uses a single PUT', async () => {
        FS.writeFileSync(cli.local('small.txt'), 'small')
        const { code } = await cli.run('cp', './small.txt', ':/small.txt')
        assert.equal(code, 0)
        assert.deepEqual(simplePuts(), [
            'PUT /v1.0/me/drive/root:/small.txt:/content',
        ])
        assert.equal(cli.mock.uploadChunks.length, 0)
    })

    test('a failed chunk is sent again', async () => {
        const data = bigFile('big.bin')
        cli.mock.failChunkPuts = 2
        const { code } = await cli.run('cp', './big.bin', ':/big.bin')
        assert.equal(code, 0)
        assert.ok(cli.mock.content.get('big.bin').equals(data))
    })

    test('after a lost response it resumes where the server is', async () => {
        const data = bigFile('big.bin')
        // The first chunk is stored but its answer is lost: the next PUT must
        // start at 10 MiB, not send the first chunk again.
        cli.mock.dropChunkResponses = 1
        const { code } = await cli.run('cp', './big.bin', ':/big.bin')
        assert.equal(code, 0)
        assert.ok(cli.mock.content.get('big.bin').equals(data))
        const sent = cli.mock.uploadChunks.reduce((n, c) => n + c.length, 0)
        assert.equal(sent, data.length)
    })

    test('it gives up after repeated failures and cancels the session', async () => {
        bigFile('big.bin')
        cli.mock.failChunkPuts = 99
        const { code, stderr } = await cli.run('cp', './big.bin', ':/big.bin')
        assert.equal(code, 1)
        assert.match(stderr, /Upload failed after 5 attempts/)
        assert.equal(cli.mock.sessions.size, 0)
        assert.equal(cli.mock.content.has('big.bin'), false)
    })

    test('a lost answer to the final chunk is checked against the destination', async () => {
        const data = bigFile('big.bin')
        // The file is committed, the answer is lost and the finished session
        // is gone: the item at the destination must be recognised as ours.
        cli.mock.loseFinalChunkResponse = 1
        const { code, stdout, stderr } = await cli.run(
            'cp',
            './big.bin',
            ':/big.bin'
        )
        assert.equal(code, 0, stderr)
        assert.match(stdout, /big\.bin -> \/me\/drive\/root:\/big\.bin:/)
        assert.ok(cli.mock.content.get('big.bin').equals(data))
        assert.ok(
            cli.mock.requests.includes('GET /v1.0/me/drive/root:/big.bin:')
        )
    })

    test('after a lost final answer, a different file there is left alone', async () => {
        const data = bigFile('big.bin')
        // Someone else's file of the same size lands there first.
        const other = Buffer.alloc(data.length, 7)
        cli.mock.onFinalChunk = path =>
            cli.mock.addFile(path, other, new Date().toISOString())
        cli.mock.loseFinalChunkResponse = 1
        const { code, stderr } = await cli.run('cp', './big.bin', ':/big.bin')
        assert.equal(code, 1)
        assert.match(stderr, /Upload outcome unknown/)
        assert.match(stderr, /does not match the local file/)
        assert.ok(cli.mock.content.get('big.bin').equals(other))
        assert.ok(FS.existsSync(cli.local('big.bin')))
    })

    test('after a lost final answer, an older identical file is not claimed', async () => {
        const data = bigFile('big.bin')
        // E.g. a copy moved into place: same bytes, but not this upload.
        cli.mock.onFinalChunk = path =>
            cli.mock.addFile(path, data, '2000-01-01T00:00:00Z')
        cli.mock.loseFinalChunkResponse = 1
        const { code, stderr } = await cli.run('mv', './big.bin', ':/big.bin')
        assert.equal(code, 1)
        assert.match(stderr, /modified before this upload started/)
        assert.ok(FS.existsSync(cli.local('big.bin')))
    })

    test('a large upload never overwrites an existing file', async () => {
        bigFile('hello.txt')
        const { code, stderr } = await cli.run('cp', './hello.txt', ':/')
        assert.equal(code, 1)
        assert.match(stderr, /already exists/)
        assert.equal(
            cli.mock.content.get('hello.txt').toString(),
            'hello world'
        )
    })
})
