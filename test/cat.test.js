'use strict'

const assert = require('node:assert/strict')
const { exec, spawn } = require('node:child_process')
const Path = require('node:path')
const { beforeEach, describe, test } = require('node:test')
const { useCli } = require('./helpers/cli')

const cli = useCli()

const BIN = Path.join(__dirname, '..', 'bin', 'onedrive')

beforeEach(() => {
    cli.mock.gzipDownloads = false
})

// 8 MiB of distinct bytes, larger than any pipe buffer.
function bigFile() {
    const data = Buffer.alloc(8 * 1024 * 1024)
    for (let i = 0; i < data.length; i += 4) {
        data.writeUInt32LE(i, i)
    }
    cli.mock.addFile('big.bin', data)
    return data
}

// Run a shell pipeline that starts with the CLI.
function pipeline(command) {
    return new Promise(resolve =>
        exec(
            JSON.stringify(process.execPath) +
                ' ' +
                JSON.stringify(BIN) +
                ' ' +
                command,
            {
                cwd: cli.cwd,
                encoding: 'buffer',
                maxBuffer: 64 * 1024 * 1024,
                env: {
                    PATH: process.env.PATH,
                    XDG_STATE_HOME: cli.home,
                    ...cli.mock.env(),
                },
            },
            (err, stdout, stderr) =>
                resolve({ code: err ? err.code : 0, stdout, stderr })
        )
    )
}

describe('cat (#70)', () => {
    test('streams a large file intact', async () => {
        const data = bigFile()
        const { code, stdout } = await pipeline('cat :/big.bin')
        assert.equal(code, 0)
        assert.ok(stdout.equals(data))
    })

    test('keeps up with a slow reader', async () => {
        const data = bigFile()
        // dd reads in small blocks, so stdout fills and must drain.
        const { code, stdout } = await pipeline(
            'cat :/big.bin | dd bs=4096 2>/dev/null | cat'
        )
        assert.equal(code, 0)
        assert.ok(stdout.equals(data))
    })

    test('a reader that stops early is not an error', async () => {
        bigFile()
        const { code, stdout, stderr } = await pipeline(
            'cat :/big.bin | head -c 10'
        )
        assert.equal(code, 0)
        assert.equal(stdout.length, 10)
        assert.doesNotMatch(stderr.toString(), /EPIPE|Error/)
    })

    test('several files are written in order', async () => {
        const { stdout } = await cli.run(
            'cat',
            ':/hello.txt',
            ':/Documents/report one.txt'
        )
        assert.equal(stdout, "hello worldit's a report")
    })
})

// Run the CLI with its stdout closed before it writes anything, as when the
// reader at the end of a pipe has already gone away.
function runWithStdoutClosed(...args) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [BIN, ...args], {
            cwd: cli.cwd,
            env: {
                PATH: process.env.PATH,
                XDG_STATE_HOME: cli.home,
                ...cli.mock.env(),
            },
        })
        child.stdout.destroy()
        let stderr = ''
        child.stderr.on('data', data => (stderr += data))
        child.on('close', code => resolve({ code, stderr }))
    })
}

describe('a reader that goes away', () => {
    test('cat stops quietly and fetches no more files', async () => {
        bigFile()
        const { code, stdout, stderr } = await pipeline(
            'cat :/big.bin :/hello.txt | head -c 10'
        )
        assert.equal(code, 0)
        assert.equal(stdout.length, 10)
        assert.doesNotMatch(stderr.toString(), /EPIPE|Error|at /)
        assert.ok(
            !cli.mock.requests.some(r => r.includes('hello.txt')),
            'the second file was not downloaded'
        )
    })

    test('rm still removes every item', async () => {
        cli.mock.addFile('a.txt', 'a').addFile('b.txt', 'b')
        const { code, stderr } = await runWithStdoutClosed(
            'rm',
            ':/a.txt',
            ':/hello.txt',
            ':/b.txt'
        )
        assert.equal(code, 0)
        assert.equal(stderr, '')
        for (const name of ['a.txt', 'hello.txt', 'b.txt']) {
            assert.ok(!cli.mock.items.has(name), name + ' was removed')
        }
    })

    test('rm that fails still exits non-zero', async () => {
        cli.mock.addFile('a.txt', 'a').addFile('b.txt', 'b')
        const { code, stderr } = await runWithStdoutClosed(
            'rm',
            ':/a.txt',
            ':/missing.txt',
            ':/b.txt'
        )
        assert.notEqual(code, 0)
        assert.match(stderr, /not found/i)
        assert.ok(!cli.mock.items.has('a.txt'), 'a.txt was removed')
        assert.ok(cli.mock.items.has('b.txt'), 'rm stopped at the failure')
    })
})

describe('compressed downloads (#37)', () => {
    test('cat asks for gzip and inflates the answer', async () => {
        cli.mock.gzipDownloads = true
        const { code, stdout } = await cli.run('cat', ':/hello.txt')
        assert.equal(code, 0)
        assert.equal(stdout, 'hello world')
        assert.match(cli.mock.downloadEncodings[0], /\bgzip\b/)
    })

    test('cp asks for gzip too', async () => {
        cli.mock.gzipDownloads = true
        const { code } = await cli.run('cp', ':/hello.txt', './')
        assert.equal(code, 0)
        assert.match(cli.mock.downloadEncodings[0], /\bgzip\b/)
    })
})
