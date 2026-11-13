'use strict'

const assert = require('node:assert/strict')
const { describe, test } = require('node:test')
const { useCli } = require('./helpers/cli')

const cli = useCli()

const DAY = 864e5
const ago = days => new Date(Date.now() - days * DAY).toISOString()

// :/hello.txt (11 B), :/Documents/report one.txt (13 B) from the helper, plus:
function addTree() {
    cli.mock
        .addFolder('Documents/2024')
        .addFile('Documents/2024/old.bin', Buffer.alloc(3 * 1024 * 1024))
        .setModified('Documents/2024/old.bin', ago(400))
        .addFile('Documents/2024/empty.txt', '')
        .addFolder('Documents/2024/Deep')
        .addFile('Documents/2024/Deep/new.txt', 'new')
        .setModified('Documents/2024/Deep/new.txt', ago(0.01))
}

async function find(...args) {
    const { code, stdout, stderr } = await cli.run('find', ':/', ...args)
    assert.equal(code, 0, stderr)
    return stdout.trim().split('\n').filter(Boolean).sort()
}

describe('find predicates (#39)', () => {
    test('-maxdepth stops descending, and saves the requests', async () => {
        addTree()
        assert.deepEqual(await find('-maxdepth', '1'), [
            ':/Documents',
            ':/My Files',
            ':/hello.txt',
        ])
        assert.deepEqual(
            cli.mock.requests.filter(r => r.startsWith('GET /v1.0/')),
            ['GET /v1.0/me/drive/root/children']
        )
        assert.equal((await find('-maxdepth', '3', '-type', 'f')).length, 4)
    })

    test('-mindepth skips the shallow levels', async () => {
        addTree()
        assert.deepEqual(await find('-mindepth', '4'), [
            ':/Documents/2024/Deep/new.txt',
        ])
    })

    test('-size with units, rounded up like find(1)', async () => {
        addTree()
        assert.deepEqual(await find('-type', 'f', '-size', '+1M'), [
            ':/Documents/2024/old.bin',
        ])
        assert.deepEqual(await find('-type', 'f', '-size', '-1k'), [
            ':/Documents/2024/empty.txt',
        ])
        assert.deepEqual(await find('-size', '11c'), [':/hello.txt'])
    })

    test('-mtime and -mmin', async () => {
        addTree()
        assert.deepEqual(await find('-mtime', '+365'), [
            ':/Documents/2024/old.bin',
        ])
        assert.deepEqual(await find('-mmin', '-60'), [
            ':/Documents/2024/Deep/new.txt',
        ])
    })

    test('-empty matches empty files and folders', async () => {
        addTree()
        assert.deepEqual(await find('-empty'), [
            ':/Documents/2024/empty.txt',
            ':/My Files',
        ])
    })

    test('predicates combine with -name and -type', async () => {
        addTree()
        assert.deepEqual(await find('-name', '*.txt', '-size', '-1k'), [
            ':/Documents/2024/empty.txt',
        ])
    })

    test('a bad argument is an error', async () => {
        const { code, stderr } = await cli.run('find', ':/', '-size', 'big')
        assert.equal(code, 1)
        assert.match(stderr, /invalid argument to -size/)
    })
})
