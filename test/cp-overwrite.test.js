'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const FS = require('node:fs')
const Path = require('node:path')
const { describe, test } = require('node:test')
const { useCli } = require('./helpers/cli')

const cli = useCli()

const BIN = Path.join(__dirname, '..', 'bin', 'onedrive')

// Like cli.run, with an answer for -i on stdin.
function runWithInput(input, ...args) {
    return new Promise(resolve => {
        const child = execFile(
            process.execPath,
            [BIN, ...args],
            {
                cwd: cli.cwd,
                env: {
                    PATH: process.env.PATH,
                    XDG_STATE_HOME: cli.home,
                    ...cli.mock.env(),
                },
            },
            (err, stdout, stderr) =>
                resolve({ code: err ? err.code : 0, stdout, stderr })
        )
        child.stdin.end(input)
    })
}

const remote = name => cli.mock.content.get(name).toString()
const local = name => FS.readFileSync(cli.local(name), 'utf8')

describe('cp/mv overwrite options (#22)', () => {
    test('by default an upload still refuses to overwrite', async () => {
        FS.writeFileSync(cli.local('hello.txt'), 'new')
        const { code, stderr } = await cli.run('cp', './hello.txt', ':/')
        assert.equal(code, 1)
        assert.match(stderr, /already exists/)
        assert.equal(remote('hello.txt'), 'hello world')
    })

    test('-f overwrites the remote file', async () => {
        FS.writeFileSync(cli.local('hello.txt'), 'new')
        const { code } = await cli.run('cp', '-f', './hello.txt', ':/')
        assert.equal(code, 0)
        assert.equal(remote('hello.txt'), 'new')
    })

    test('-n skips an existing remote file without an error', async () => {
        FS.writeFileSync(cli.local('hello.txt'), 'new')
        FS.writeFileSync(cli.local('other.txt'), 'other')
        const { code, stdout } = await cli.run(
            'cp',
            '-n',
            './hello.txt',
            './other.txt',
            ':/'
        )
        assert.equal(code, 0)
        assert.match(stdout, /exists, skipped/)
        assert.equal(remote('hello.txt'), 'hello world')
        assert.equal(remote('other.txt'), 'other')
    })

    test('mv -n keeps the local file it did not move', async () => {
        FS.writeFileSync(cli.local('hello.txt'), 'new')
        const { code } = await cli.run('mv', '-n', './hello.txt', ':/')
        assert.equal(code, 0)
        assert.equal(local('hello.txt'), 'new')
    })

    test('-n skips an existing local file on download', async () => {
        FS.writeFileSync(cli.local('hello.txt'), 'mine')
        const { code } = await cli.run('cp', '-n', ':/hello.txt', './')
        assert.equal(code, 0)
        assert.equal(local('hello.txt'), 'mine')
    })

    test('-i asks, and only "y" overwrites', async () => {
        FS.writeFileSync(cli.local('hello.txt'), 'new')
        let result = await runWithInput('n\n', 'cp', '-i', './hello.txt', ':/')
        assert.equal(result.code, 0)
        assert.match(result.stderr, /overwrite .*hello\.txt/)
        assert.equal(remote('hello.txt'), 'hello world')
        result = await runWithInput('y\n', 'cp', '-i', './hello.txt', ':/')
        assert.equal(result.code, 0)
        assert.equal(remote('hello.txt'), 'new')
    })

    test('-i on a download asks before replacing a local file', async () => {
        FS.writeFileSync(cli.local('hello.txt'), 'mine')
        await runWithInput('n\n', 'cp', '-i', ':/hello.txt', './')
        assert.equal(local('hello.txt'), 'mine')
        await runWithInput('y\n', 'cp', '-i', ':/hello.txt', './')
        assert.equal(local('hello.txt'), 'hello world')
    })

    test('options combine with -R and -t, and re-running -Rn works', async () => {
        FS.mkdirSync(cli.local('copy'))
        assert.equal((await cli.run('cp', '-R', ':/', './copy')).code, 0)
        FS.writeFileSync(cli.local('copy/hello.txt'), 'mine')
        const { code } = await cli.run('cp', '-Rn', ':/', './copy')
        assert.equal(code, 0)
        assert.equal(local('copy/hello.txt'), 'mine')
        FS.writeFileSync(cli.local('t.txt'), 't')
        assert.equal((await cli.run('cp', '-f', '-t', ':/', './t.txt')).code, 0)
        assert.equal(remote('t.txt'), 't')
    })

    test('an unknown option is an error', async () => {
        const { code, stderr } = await cli.run('cp', '-x', 'a', 'b')
        assert.equal(code, 1)
        assert.match(stderr, /Unknown option: -x/)
    })
})
