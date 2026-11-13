'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
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
