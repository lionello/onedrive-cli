'use strict'

const assert = require('node:assert/strict')
const { describe, test } = require('node:test')
const { useCli } = require('./helpers/cli')

const cli = useCli()

const KiB = 1024

function addTree() {
    cli.mock
        .addFile('Documents/a.bin', Buffer.alloc(3 * KiB))
        .addFolder('Documents/Old')
        .addFile('Documents/Old/b.bin', Buffer.alloc(2 * KiB + 1))
        .addFile('My Files/c.bin', Buffer.alloc(KiB))
}

const lines = stdout => stdout.trim().split('\n')

describe('du', () => {
    test('-d 1 on the root is one listing request', async () => {
        addTree()
        const { code, stdout } = await cli.run('du', '-d', '1', ':/')
        assert.equal(code, 0)
        // Documents = report (13 B) + a.bin + b.bin; folder sizes are recursive.
        assert.deepEqual(lines(stdout), [
            '6\t:/Documents',
            '1\t:/My Files',
            '7\t:/',
        ])
        const listings = cli.mock.requests.filter(r => r.startsWith('GET '))
        assert.deepEqual(listings, ['GET /v1.0/me/drive/root/children'])
    })

    test('without -d it descends all the way, children first', async () => {
        addTree()
        const { stdout } = await cli.run('du', ':/Documents')
        assert.deepEqual(lines(stdout), [
            '3\t:/Documents/Old',
            '6\t:/Documents',
        ])
    })

    test('-s prints one line from the item itself', async () => {
        addTree()
        const { stdout } = await cli.run('du', '-s', ':/Documents')
        assert.deepEqual(lines(stdout), ['6\t:/Documents'])
        assert.ok(
            cli.mock.requests.includes('GET /v1.0/me/drive/root:/Documents:')
        )
    })

    test('-a lists files, -c adds a total, -h humanizes', async () => {
        addTree()
        const { stdout } = await cli.run(
            'du',
            '-ac',
            '-h',
            ':/Documents/Old',
            ':/My Files'
        )
        // humanize() keeps up to four digits before switching unit, as in df.
        assert.deepEqual(lines(stdout), [
            '2049\t:/Documents/Old/b.bin',
            '2049\t:/Documents/Old',
            '1024\t:/My Files/c.bin',
            '1024\t:/My Files',
            '3073\ttotal',
        ])
    })

    test('the default path is the root', async () => {
        const { stdout } = await cli.run('du', '-d0')
        assert.deepEqual(lines(stdout), ['1\t:/'])
    })

    test('a bad depth is an error', async () => {
        const { code, stderr } = await cli.run('du', '-d', 'x')
        assert.equal(code, 1)
        assert.match(stderr, /invalid depth/)
    })
})
