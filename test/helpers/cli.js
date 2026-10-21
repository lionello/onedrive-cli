'use strict'

// Shared setup for end-to-end tests that run bin/onedrive against the mock
// Graph server: a fresh token directory and working directory per test, and a
// small drive. Call useCli() at the top of a test file.

const { execFile } = require('node:child_process')
const FS = require('node:fs')
const OS = require('node:os')
const Path = require('node:path')
const { after, before, beforeEach } = require('node:test')
const { SCOPES, TokenStore } = require('../../lib/auth')
const { MockGraph } = require('./mock-graph')

const BIN = Path.join(__dirname, '..', '..', 'bin', 'onedrive')

function useCli() {
    const ctx = {}

    ctx.run = (...args) =>
        new Promise(resolve => {
            execFile(
                process.execPath,
                [BIN, ...args],
                {
                    cwd: ctx.cwd,
                    encoding: 'buffer',
                    env: {
                        PATH: process.env.PATH,
                        XDG_STATE_HOME: ctx.home,
                        ...ctx.mock.env(),
                    },
                },
                (err, stdout, stderr) =>
                    resolve({
                        code: err ? err.code : 0,
                        stdout: stdout.toString(),
                        stdoutBuffer: stdout,
                        stderr: stderr.toString(),
                    })
            )
        })

    ctx.signIn = async () => {
        const tokens = ctx.mock.issueTokens()
        await ctx.tokenStore.write({
            version: 2,
            client_id: 'test-client',
            tenant: 'common',
            scope: SCOPES.readwrite,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Date.now() + 3600 * 1000,
        })
    }

    ctx.local = name => Path.join(ctx.cwd, name)

    before(async () => {
        ctx.mock = await new MockGraph().start()
    })

    after(() => ctx.mock.stop())

    beforeEach(async () => {
        ctx.home = FS.mkdtempSync(Path.join(OS.tmpdir(), 'onedrive-home-'))
        ctx.cwd = FS.mkdtempSync(Path.join(OS.tmpdir(), 'onedrive-cwd-'))
        ctx.tokenStore = new TokenStore(
            Path.join(ctx.home, '.onedrive-cli-token')
        )
        const mock = ctx.mock
        mock.items.clear()
        mock.content.clear()
        mock.addFolder('')
            .addFolder('Documents')
            .addFolder('My Files')
            .addFile('hello.txt', 'hello world')
            .addFile('Documents/report one.txt', "it's a report")
        // Empty every request log the mock keeps (requests, tokenRequests, ...).
        for (const value of Object.values(mock)) {
            if (Array.isArray(value)) {
                value.length = 0
            }
        }
        mock.corruptUploadHash = false
        await ctx.signIn()
    })

    return ctx
}

module.exports = { useCli }
