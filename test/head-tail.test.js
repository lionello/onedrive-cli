'use strict'

const assert = require('node:assert/strict')
const { describe, test } = require('node:test')
const { useCli } = require('./helpers/cli')

const cli = useCli()

// 1..30, one number per line, and a large file that spans several chunks.
const LINES = Array.from({ length: 30 }, (_, i) => i + 1).join('\n') + '\n'
const BIG = Buffer.alloc(200 * 1024, 'x')
BIG.write('first\n', 0)
BIG.write('\nlast\n', BIG.length - 6)

describe('head', () => {
    test('prints the first 10 lines by default', async () => {
        cli.mock.addFile('lines.txt', LINES)
        const { code, stdout } = await cli.run('head', ':/lines.txt')
        assert.equal(code, 0)
        assert.equal(stdout, LINES.split('\n').slice(0, 10).join('\n') + '\n')
    })

    test('-n and -c', async () => {
        cli.mock.addFile('lines.txt', LINES)
        assert.equal(
            (await cli.run('head', '-n', '2', ':/lines.txt')).stdout,
            '1\n2\n'
        )
        assert.equal(
            (await cli.run('head', '-n2', ':/lines.txt')).stdout,
            '1\n2\n'
        )
        assert.equal(
            (await cli.run('head', '-c', '5', ':/hello.txt')).stdout,
            'hello'
        )
        assert.equal(
            (await cli.run('head', '-c', '0', ':/hello.txt')).stdout,
            ''
        )
    })

    test('asks for a byte range instead of the whole file', async () => {
        cli.mock.addFile('big.bin', BIG)
        const { stdout } = await cli.run('head', '-n', '1', ':/big.bin')
        assert.equal(stdout, 'first\n')
        assert.ok(cli.mock.ranges.length > 0)
        assert.ok(cli.mock.ranges.every(r => r.length <= 64 * 1024))
    })

    test('a file shorter than the request is printed whole', async () => {
        const { stdout } = await cli.run('head', '-n', '5', ':/hello.txt')
        assert.equal(stdout, 'hello world')
    })

    test('several files get a header each', async () => {
        const { stdout } = await cli.run(
            'head',
            '-c',
            '5',
            ':/hello.txt',
            ':/Documents/report one.txt'
        )
        assert.equal(
            stdout,
            "==> :/hello.txt <==\nhello\n==> :/Documents/report one.txt <==\nit's "
        )
    })
})

describe('tail', () => {
    test('prints the last 10 lines by default', async () => {
        cli.mock.addFile('lines.txt', LINES)
        const { code, stdout } = await cli.run('tail', ':/lines.txt')
        assert.equal(code, 0)
        assert.equal(stdout, LINES.split('\n').slice(20).join('\n'))
    })

    test('-n and -c', async () => {
        cli.mock.addFile('lines.txt', LINES)
        assert.equal(
            (await cli.run('tail', '-n', '2', ':/lines.txt')).stdout,
            '29\n30\n'
        )
        assert.equal(
            (await cli.run('tail', '-c', '5', ':/hello.txt')).stdout,
            'world'
        )
        assert.equal(
            (await cli.run('tail', '-c', '99', ':/hello.txt')).stdout,
            'hello world'
        )
        assert.equal(
            (await cli.run('tail', '-n', '0', ':/hello.txt')).stdout,
            ''
        )
    })

    test('a last line without a newline still counts', async () => {
        cli.mock.addFile('nonl.txt', 'a\nb\nc')
        assert.equal(
            (await cli.run('tail', '-n', '2', ':/nonl.txt')).stdout,
            'b\nc'
        )
    })

    test('walks back over several chunks of a large file', async () => {
        cli.mock.addFile('big.bin', BIG)
        const { stdout } = await cli.run('tail', '-n', '1', ':/big.bin')
        assert.equal(stdout, 'last\n')
        const whole = await cli.run('tail', '-n', '3', ':/big.bin')
        assert.equal(whole.stdoutBuffer.length, BIG.length)
    })

    test('a folder is an error', async () => {
        const { code, stderr } = await cli.run('tail', ':/Documents')
        assert.equal(code, 1)
        assert.match(stderr, /Is a directory/)
    })
})
