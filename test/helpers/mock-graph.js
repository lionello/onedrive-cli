'use strict'

// An in-memory stand-in for Microsoft Graph and the Microsoft identity
// platform -- just enough of both to run the CLI end to end without a network
// or an account. Point the CLI at it with ONEDRIVE_GRAPH_URL and
// ONEDRIVE_AUTHORITY_HOST.

const Crypto = require('crypto')
const Http = require('http')
const { quickXorHash } = require('../../lib/quickxorhash')

const base64url = buffer =>
    buffer
        .toString('base64')
        .replace(/=+$/, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')

class MockGraph {
    constructor() {
        this.accessTokens = new Set()
        this.refreshTokens = new Set()
        this.codes = new Map() // authorization code -> PKCE challenge
        this.devicePolls = 0
        this.devicePendingPolls = 1
        this.requests = [] // "METHOD /path" of every request, for assertions
        this.tokenRequests = [] // grant_type of every token request
        this.corruptUploadHash = false
        this.hashKind = 'quickXorHash' // or 'sha1Hash', as on older items
        this.nextId = 1
        this.items = new Map() // path ('' = root) -> item
        this.content = new Map() // path -> Buffer
        this.addFolder('')
    }

    // --- drive contents --------------------------------------------------

    addFolder(path) {
        this.items.set(path, { id: 'item' + this.nextId++, folder: true })
        return this
    }

    addFile(path, data) {
        const buffer = Buffer.from(data)
        this.items.set(path, { id: 'item' + this.nextId++, folder: false })
        this.content.set(path, buffer)
        return this
    }

    children(path) {
        const prefix = path === '' ? '' : path + '/'
        return [...this.items.keys()].filter(
            p =>
                p !== path &&
                p.startsWith(prefix) &&
                !p.slice(prefix.length).includes('/')
        )
    }

    // A driveItem as Graph returns it.
    item(path) {
        const entry = this.items.get(path)
        const parts = path.split('/')
        const name = path === '' ? 'root' : parts.pop()
        const parentPath = parts.join('/')
        const result = {
            id: entry.id,
            name,
            lastModifiedDateTime: '2026-01-02T03:04:05Z',
            createdBy: { user: { displayName: 'Test User' } },
        }
        if (path !== '') {
            result.parentReference = {
                driveId: 'drive1',
                path:
                    '/drive/root:' +
                    (parentPath
                        ? '/' +
                          parentPath
                              .split('/')
                              .map(encodeURIComponent)
                              .join('/')
                        : ''),
            }
        }
        if (entry.folder) {
            result.size = 0
            result.folder = { childCount: this.children(path).length }
        } else {
            const data = this.content.get(path)
            result.size = data.length
            result.file = {
                mimeType: 'application/octet-stream',
                hashes:
                    this.hashKind === 'sha1Hash'
                        ? {
                              sha1Hash: Crypto.createHash('sha1')
                                  .update(data)
                                  .digest('hex')
                                  .toUpperCase(),
                          }
                        : { quickXorHash: quickXorHash(data) },
            }
        }
        return result
    }

    // --- tokens ----------------------------------------------------------

    issueTokens() {
        const access = 'at-' + Crypto.randomBytes(6).toString('hex')
        const refresh = 'rt-' + Crypto.randomBytes(6).toString('hex')
        this.accessTokens.add(access)
        this.refreshTokens.add(refresh)
        return {
            token_type: 'Bearer',
            scope: 'Files.ReadWrite.All',
            expires_in: 3600,
            access_token: access,
            refresh_token: refresh,
        }
    }

    // Make the next browser sign-in succeed: the test plays the browser and
    // comes back with this code; the token endpoint checks it against the
    // PKCE challenge from the authorize URL.
    approveCode(code, challenge) {
        this.codes.set(code, challenge)
    }

    revokeAccessTokens() {
        this.accessTokens.clear()
    }

    // --- HTTP ------------------------------------------------------------

    async start() {
        this.server = Http.createServer((req, res) => this.handle(req, res))
        await new Promise(resolve =>
            this.server.listen(0, '127.0.0.1', resolve)
        )
        this.url = 'http://127.0.0.1:' + this.server.address().port
        return this
    }

    stop() {
        return new Promise(resolve => this.server.close(resolve))
    }

    env() {
        return {
            ONEDRIVE_GRAPH_URL: this.url + '/v1.0',
            ONEDRIVE_AUTHORITY_HOST: this.url,
            ONEDRIVE_CLIENT_ID: 'test-client',
        }
    }

    async handle(req, res) {
        const chunks = []
        for await (const chunk of req) {
            chunks.push(chunk)
        }
        const body = Buffer.concat(chunks)
        const url = new URL(req.url, this.url)
        this.requests.push(req.method + ' ' + decodeURIComponent(url.pathname))
        const json = (status, data) =>
            res
                .writeHead(status, { 'Content-Type': 'application/json' })
                .end(JSON.stringify(data))
        try {
            if (url.pathname.includes('/oauth2/v2.0/')) {
                return this.identity(url, body, json)
            }
            if (url.pathname.startsWith('/download/')) {
                return this.download(req, res, url)
            }
            if (url.pathname.startsWith('/v1.0/')) {
                const auth = req.headers.authorization || ''
                if (!this.accessTokens.has(auth.replace(/^Bearer /, ''))) {
                    return json(401, {
                        error: {
                            code: 'InvalidAuthenticationToken',
                            message: 'Access token is empty or invalid.',
                        },
                    })
                }
                return this.graph(req, res, url, body, json)
            }
            json(404, { error: { code: 'notFound', message: 'No route' } })
        } catch (err) {
            json(500, { error: { code: 'mockError', message: err.message } })
        }
    }

    identity(url, body, json) {
        const form = new URLSearchParams(body.toString())
        if (url.pathname.endsWith('/devicecode')) {
            return json(200, {
                device_code: 'device-123',
                user_code: 'ABCD-1234',
                verification_uri: 'https://microsoft.com/devicelogin',
                expires_in: 60,
                interval: 0.01,
                message:
                    'To sign in, open https://microsoft.com/devicelogin and enter the code ABCD-1234.',
            })
        }
        const grant = form.get('grant_type')
        this.tokenRequests.push(grant)
        if (grant === 'refresh_token') {
            if (!this.refreshTokens.delete(form.get('refresh_token'))) {
                return json(400, {
                    error: 'invalid_grant',
                    error_description:
                        'AADSTS70008: The refresh token has expired.',
                })
            }
            return json(200, this.issueTokens())
        }
        if (grant === 'authorization_code') {
            const challenge = this.codes.get(form.get('code'))
            const verifier = form.get('code_verifier') || ''
            const expected = base64url(
                Crypto.createHash('sha256').update(verifier).digest()
            )
            if (!challenge || challenge !== expected) {
                return json(400, {
                    error: 'invalid_grant',
                    error_description: 'PKCE verification failed.',
                })
            }
            this.codes.delete(form.get('code'))
            return json(200, this.issueTokens())
        }
        if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
            if (++this.devicePolls <= this.devicePendingPolls) {
                return json(400, { error: 'authorization_pending' })
            }
            return json(200, this.issueTokens())
        }
        json(400, { error: 'unsupported_grant_type' })
    }

    // /v1.0/me/drive/root[:/{path}:][/{action}]
    resolve(pathname) {
        const prefix = '/v1.0/me/drive/root'
        if (!pathname.startsWith(prefix)) {
            return null
        }
        let rest = pathname.slice(prefix.length)
        let path = ''
        if (rest.startsWith(':/')) {
            const end = rest.indexOf(':', 2)
            path = decodeURIComponent(rest.slice(2, end))
            rest = rest.slice(end + 1)
        }
        return { path, action: rest.replace(/^\//, '') }
    }

    graph(req, res, url, body, json) {
        const notFound = () =>
            json(404, {
                error: { code: 'itemNotFound', message: 'Item not found' },
            })
        if (url.pathname === '/v1.0/me/drives') {
            return json(200, {
                value: [
                    {
                        id: 'drive1',
                        driveType: 'business',
                        quota: {
                            total: 1024 ** 4,
                            used: 1024 ** 3,
                            remaining: 1024 ** 4 - 1024 ** 3,
                            deleted: 0,
                            state: 'normal',
                        },
                    },
                ],
            })
        }
        const search = /^\/v1\.0\/me\/drive\/root\/search\(q='(.*)'\)$/.exec(
            decodeURIComponent(url.pathname)
        )
        if (search) {
            const query = search[1].replace(/''/g, "'")
            return json(200, {
                value: [...this.items.keys()]
                    .filter(p => p && p.split('/').pop().includes(query))
                    .map(p => this.item(p)),
            })
        }
        const byId = /^\/v1\.0\/me\/drive\/items\/([^/]+)$/.exec(url.pathname)
        if (byId && req.method === 'PATCH') {
            return this.move(byId[1], JSON.parse(body.toString()), json)
        }
        const target = this.resolve(url.pathname)
        if (!target) {
            return notFound()
        }
        const { path, action } = target
        if (action === '' && req.method === 'GET') {
            return this.items.has(path)
                ? json(200, this.item(path))
                : notFound()
        }
        if (action === '' && req.method === 'PATCH') {
            if (!this.items.has(path)) {
                return notFound()
            }
            return this.move(
                this.items.get(path).id,
                JSON.parse(body.toString()),
                json
            )
        }
        if (action === '' && req.method === 'DELETE') {
            if (!this.items.has(path)) {
                return notFound()
            }
            for (const p of [...this.items.keys()]) {
                if (p === path || p.startsWith(path + '/')) {
                    this.items.delete(p)
                    this.content.delete(p)
                }
            }
            return res.writeHead(204).end()
        }
        if (action === 'children' && req.method === 'GET') {
            if (!this.items.has(path)) {
                return notFound()
            }
            return json(200, {
                value: this.children(path).map(p => this.item(p)),
            })
        }
        if (action === 'children' && req.method === 'POST') {
            const { name } = JSON.parse(body.toString())
            const child = path ? path + '/' + name : name
            this.addFolder(child)
            return json(201, this.item(child))
        }
        if (action === 'content' && req.method === 'GET') {
            if (!this.content.has(path)) {
                return notFound()
            }
            // Like Graph: redirect to a pre-authenticated download URL.
            return res
                .writeHead(302, {
                    Location:
                        this.url +
                        '/download/' +
                        encodeURIComponent(path) +
                        '?sig=1',
                })
                .end()
        }
        if (action === 'content' && req.method === 'PUT') {
            if (
                this.items.has(path) &&
                url.searchParams.get('@microsoft.graph.conflictBehavior') ===
                    'fail'
            ) {
                return json(409, {
                    error: {
                        code: 'nameAlreadyExists',
                        message:
                            'An item with the same name already exists under the parent',
                    },
                })
            }
            this.addFile(path, body)
            const item = this.item(path)
            if (this.corruptUploadHash) {
                item.file.hashes.quickXorHash = quickXorHash(Buffer.from('x'))
            }
            return json(201, item)
        }
        notFound()
    }

    move(id, patch, json) {
        const from = [...this.items.keys()].find(
            p => this.items.get(p).id === id
        )
        const parent = [...this.items.keys()].find(
            p => this.items.get(p).id === patch.parentReference.id
        )
        if (from === undefined || parent === undefined) {
            return json(404, {
                error: { code: 'itemNotFound', message: 'Item not found' },
            })
        }
        const to = (parent ? parent + '/' : '') + patch.name
        this.items.set(to, this.items.get(from))
        this.items.delete(from)
        if (this.content.has(from)) {
            this.content.set(to, this.content.get(from))
            this.content.delete(from)
        }
        json(200, this.item(to))
    }

    download(req, res, url) {
        const path = decodeURIComponent(url.pathname.slice('/download/'.length))
        const data = this.content.get(path)
        if (!data) {
            return res.writeHead(404).end()
        }
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '')
        if (range) {
            const start = Number(range[1])
            if (start >= data.length) {
                return res
                    .writeHead(416, {
                        'Content-Range': 'bytes */' + data.length,
                    })
                    .end()
            }
            const end = Math.min(Number(range[2]), data.length - 1)
            return res
                .writeHead(206, {
                    'Content-Range':
                        'bytes ' + start + '-' + end + '/' + data.length,
                })
                .end(data.subarray(start, end + 1))
        }
        res.writeHead(200).end(data)
    }
}

module.exports = { MockGraph, base64url }
