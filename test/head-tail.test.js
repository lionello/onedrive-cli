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
// One line longer than a chunk, and one longer than what tail keeps in memory.
const LONG = 'x'.repeat(300 * 1024)
const HUGE = 'y'.repeat(2.5 * 1024 * 1024)

const downloads = () =>
    cli.mock.requests.filter(r => r.startsWith('GET /download/')).length
const chunked = () => cli.mock.ranges.every(r => r.length <= 64 * 1024)

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

    test('a line longer than a chunk is streamed through', async () => {
        cli.mock.addFile('long.txt', LONG + '\nnext\n')
        const { stdout } = await cli.run('head', '-n', '1', ':/long.txt')
        assert.equal(stdout, LONG + '\n')
        assert.ok(chunked())
        assert.equal(downloads(), 5)
        const nonl = await cli.run('head', '-n', '1', ':/hello.txt')
        assert.equal(nonl.stdout, 'hello world')
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

    test('a line longer than it keeps in memory is streamed again', async () => {
        cli.mock.addFile('huge.txt', 'first\n' + HUGE + '\n')
        const { stdout } = await cli.run('tail', '-n', '1', ':/huge.txt')
        assert.equal(stdout, HUGE + '\n')
        assert.ok(chunked())
        cli.mock.addFile('long.txt', LONG)
        assert.equal((await cli.run('tail', ':/long.txt')).stdout, LONG)
    })

    test('a folder is an error', async () => {
        const { code, stderr } = await cli.run('tail', ':/Documents')
        assert.equal(code, 1)
        assert.match(stderr, /Is a directory/)
    })
})

describe('a server that ignores Range', () => {
    // Every Range request gets 200 and the whole file: each command must use
    // that one response instead of fetching the file again for every chunk.
    const run = async (...args) => {
        cli.mock.ignoreRange = true
        cli.mock.requests.length = 0
        const result = await cli.run(...args)
        assert.equal(result.code, 0)
        assert.equal(downloads(), 1)
        return result.stdout
    }

    test('head', async () => {
        cli.mock.addFile('big.bin', BIG)
        cli.mock.addFile('long.txt', LONG + '\nnext\n')
        assert.equal(await run('head', '-n', '1', ':/big.bin'), 'first\n')
        assert.equal(await run('head', '-n', '1', ':/long.txt'), LONG + '\n')
        assert.equal(await run('head', '-c', '3', ':/big.bin'), 'fir')
        assert.equal(await run('head', ':/hello.txt'), 'hello world')
    })

    test('tail', async () => {
        cli.mock.addFile('big.bin', BIG)
        cli.mock.addFile('huge.txt', 'first\n' + HUGE)
        assert.equal(await run('tail', '-n', '1', ':/big.bin'), 'last\n')
        assert.equal(await run('tail', '-n', '1', ':/huge.txt'), HUGE)
        assert.equal(await run('tail', '-c', '4', ':/big.bin'), 'ast\n')
        assert.equal(await run('tail', ':/hello.txt'), 'hello world')
        assert.equal(cli.mock.ranges.length, 0)
    })
})
