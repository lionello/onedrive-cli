'use strict'

// Sign-in against the Microsoft identity platform (the v2.0 endpoint), which
// issues Microsoft Graph tokens for personal *and* work or school accounts.
//
// - Browser sign-in: authorization code with PKCE and a loopback redirect, the
//   flow for native apps (RFC 8252). The browser lands on our own listener, so
//   no hosted callback page is involved and nothing has to be pasted.
// - Device code (RFC 8628): for SSH sessions, containers and agents, where no
//   local browser can reach a loopback listener.
//
// Both ask for offline_access, so the token file holds a refresh token and
// expired access tokens are renewed silently instead of needing a new login
// every hour.
//
// Nothing in this module prints: the CLI and the MCP server present the
// sign-in link or code in their own way (stdout is the MCP JSON-RPC channel).

const Crypto = require('crypto')
const FS = require('fs/promises')
const Http = require('http')
const fetch = require('node-fetch')

// The application (client) ID registered for onedrive-cli with the Microsoft
// identity platform: a public client for personal and work or school accounts,
// with the "Mobile and desktop" redirect URI http://localhost and public client
// flows enabled. Override it with ONEDRIVE_CLIENT_ID or `login --client-id`,
// e.g. when an organization only allows its own app registrations.
const DEFAULT_CLIENT_ID = null

// "common" accepts both personal and work or school accounts. A tenant ID or
// domain limits sign-in to that organization; "consumers" to personal accounts.
const DEFAULT_TENANT = 'common'

const SCOPES = {
    readwrite: 'Files.ReadWrite.All offline_access',
    readonly: 'Files.Read.All offline_access',
}

// Renew this long before the access token expires, so a request never races
// the expiry.
const REFRESH_MARGIN_MS = 5 * 60 * 1000

// The token file lock (see TokenStore.locked). A renewal holds it for one token
// request, which gives up after TOKEN_REQUEST_TIMEOUT_MS; a lock older than
// LOCK_STALE_MS was left behind by a process that died.
const TOKEN_REQUEST_TIMEOUT_MS = 30 * 1000
const LOCK_STALE_MS = 2 * TOKEN_REQUEST_TIMEOUT_MS
const LOCK_WAIT_MS = LOCK_STALE_MS + 10 * 1000

class AuthError extends Error {
    constructor(code, description) {
        super(description || code)
        this.code = code
        // Lets callers treat it like an HTTP 401 and prompt for a new login.
        this.statusCode = 401
    }
}

// Sign-in errors that mean the app was not granted access, typically because
// the organization requires an administrator to approve it: AADSTS65001 (no
// consent yet), AADSTS65004 (consent declined, also what the "Need admin
// approval" page returns), AADSTS90094 and AADSTS90095 (admin consent needed).
const CONSENT_ERROR = /\bAADSTS(65001|65004|90094|90095)\b/

function isConsentError(err) {
    return (
        !!err &&
        (err.code === 'consent_required' ||
            CONSENT_ERROR.test(String(err.message)))
    )
}

function authorityHost() {
    return (
        process.env.ONEDRIVE_AUTHORITY_HOST ||
        'https://login.microsoftonline.com'
    ).replace(/\/+$/, '')
}

function endpoint(tenant, name) {
    return (
        authorityHost() +
        '/' +
        encodeURIComponent(tenant) +
        '/oauth2/v2.0/' +
        name
    )
}

// Login options win over the environment, which wins over the defaults.
function resolveSettings(options = {}) {
    const clientId =
        options.clientId || process.env.ONEDRIVE_CLIENT_ID || DEFAULT_CLIENT_ID
    if (!clientId) {
        throw new Error(
            'No application (client) ID is configured. Set ONEDRIVE_CLIENT_ID ' +
                'or pass --client-id; see "Signing in" in the README.'
        )
    }
    return {
        clientId,
        tenant: options.tenant || process.env.ONEDRIVE_TENANT || DEFAULT_TENANT,
        scope: options.readonly ? SCOPES.readonly : SCOPES.readwrite,
    }
}

function base64url(buffer) {
    return buffer
        .toString('base64')
        .replace(/=+$/, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
}

function pkcePair() {
    const verifier = base64url(Crypto.randomBytes(32))
    const challenge = base64url(
        Crypto.createHash('sha256').update(verifier).digest()
    )
    return { verifier, challenge }
}

async function postForm(url, params, { timeout = 0 } = {}) {
    const resp = await fetch(url, {
        method: 'POST',
        timeout,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
    })
    let json
    try {
        json = await resp.json()
    } catch {
        throw new AuthError(
            'invalid_response',
            'Sign-in endpoint answered ' + resp.status + ' without JSON'
        )
    }
    if (json.error) {
        throw new AuthError(json.error, json.error_description)
    }
    return json
}

// What goes into the token file. The settings used at login are stored with
// the tokens so that renewals keep working whatever the environment says later.
function toRecord(response, settings, previous = {}) {
    return {
        version: 2,
        client_id: settings.clientId,
        tenant: settings.tenant,
        scope: settings.scope,
        token_type: response.token_type,
        access_token: response.access_token,
        // Some renewals return no new refresh token; keep the one we had.
        refresh_token: response.refresh_token || previous.refresh_token,
        expires_at: Date.now() + Number(response.expires_in || 3600) * 1000,
    }
}

// The token file. Holds JSON written by this module, or -- from older versions
// or `login <token>` -- a bare access token, which is used as is and cannot be
// renewed.
//
// Several processes share the file (the CLI, an MCP server, scripts), so every
// change to it -- a renewal, a login, a logout -- happens while holding a lock
// file next to it. That way a renewal that was already in flight can never
// bring back a sign-in that was removed or replaced in the meantime.
class TokenStore {
    constructor(path) {
        this.path = path
        this.lockPath = path + '.lock'
    }

    async read() {
        const text = (await FS.readFile(this.path)).toString().trim()
        if (text.startsWith('{')) {
            const record = JSON.parse(text)
            if (record && record.access_token) {
                return record
            }
        }
        return { access_token: text, legacy: true }
    }

    // Saves a new sign-in, replacing whatever was there.
    write(record) {
        return this.locked(() => this.writeUnlocked(record))
    }

    // Deletes the sign-in. Resolves whether there was one.
    remove() {
        return this.locked(() => this.removeUnlocked())
    }

    // Atomic (write a temporary file, then rename) so a reader never sees half
    // a file, and owner-only because the refresh token is a long-lived secret.
    async writeUnlocked(record) {
        const tmp = this.path + '.' + process.pid + '.tmp'
        const text =
            typeof record === 'string' ? record.trim() : JSON.stringify(record)
        await FS.writeFile(tmp, text, { mode: 0o600 })
        await FS.rename(tmp, this.path)
        return this.path
    }

    async removeUnlocked() {
        try {
            await FS.unlink(this.path)
            return true
        } catch (err) {
            if (err.code === 'ENOENT') {
                return false
            }
            throw err
        }
    }

    // Runs fn while holding the lock file, created exclusively so only one
    // process at a time holds it. A lock left behind by a process that died is
    // taken over once it is older than LOCK_STALE_MS; token requests made under
    // the lock time out well before that.
    async locked(fn) {
        const deadline = Date.now() + LOCK_WAIT_MS
        let handle
        for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
            try {
                handle = await FS.open(this.lockPath, 'wx', 0o600)
                break
            } catch (err) {
                if (err.code !== 'EEXIST') {
                    throw err
                }
            }
            if (await this.breakStaleLock()) {
                continue
            }
            if (Date.now() > deadline) {
                throw new Error(
                    'Timed out waiting for ' +
                        this.lockPath +
                        '; another onedrive process is changing the sign-in.'
                )
            }
            await new Promise(resolve => setTimeout(resolve, delay))
        }
        try {
            await handle.writeFile(String(process.pid))
            await handle.close()
            return await fn()
        } finally {
            await FS.unlink(this.lockPath).catch(() => {})
        }
    }

    async breakStaleLock() {
        let stat
        try {
            stat = await FS.stat(this.lockPath)
        } catch (err) {
            return err.code === 'ENOENT'
        }
        if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) {
            return false
        }
        // Rename rather than unlink, and only if it is still the same file, so
        // two processes breaking the same stale lock don't remove a fresh one.
        const aside = this.lockPath + '.' + process.pid + '.stale'
        try {
            await FS.rename(this.lockPath, aside)
        } catch {
            return true
        }
        const moved = await FS.stat(aside).catch(() => null)
        if (moved && moved.ino !== stat.ino) {
            // Someone took the lock between our stat and rename: give it back.
            await FS.link(aside, this.lockPath).catch(() => {})
        }
        await FS.unlink(aside).catch(() => {})
        return true
    }
}

// Hands out a valid access token, renewing it when it is about to expire.
// The file is re-read on every call, so a login from another process (e.g. the
// CLI while the MCP server runs) is picked up straight away.
class Auth {
    constructor(store) {
        this.store = store
        this.renewal = null
    }

    async accessToken({ forceRefresh = false } = {}) {
        const record = await this.store.read()
        if (record.legacy || !record.refresh_token) {
            return record.access_token
        }
        if (
            !forceRefresh &&
            Number(record.expires_at) - REFRESH_MARGIN_MS > Date.now()
        ) {
            return record.access_token
        }
        return (await this.refresh(record)).access_token
    }

    // True when a 401 is worth one retry with a renewed token.
    async canRefresh() {
        try {
            const record = await this.store.read()
            return !record.legacy && !!record.refresh_token
        } catch {
            return false
        }
    }

    // Concurrent requests in this process share one renewal instead of each
    // spending the refresh token.
    refresh(record) {
        if (!this.renewal) {
            this.renewal = this.store
                .locked(() => this.renewLocked(record))
                .finally(() => {
                    this.renewal = null
                })
        }
        return this.renewal
    }

    // Runs under the token file lock. `seen` is the record the caller found
    // expired or rejected; the file may have changed since.
    async renewLocked(seen) {
        // Throws ENOENT, i.e. "not signed in", after a logout.
        const current = await this.store.read()
        if (current.access_token !== seen.access_token) {
            // Another process renewed it or signed in again meanwhile; use
            // that, unless it too needs renewing.
            if (
                current.legacy ||
                !current.refresh_token ||
                Number(current.expires_at) - REFRESH_MARGIN_MS > Date.now()
            ) {
                return current
            }
        }
        const renewed = await this.renew(current)
        // Only replace the record the renewal started from. The lock already
        // ensures this; checking again covers a lock that was taken over as
        // stale while the request was slow.
        const latest = await this.store.read()
        if (latest.access_token !== current.access_token) {
            return latest
        }
        await this.store.writeUnlocked(renewed)
        return renewed
    }

    async renew(record) {
        const settings = {
            clientId: record.client_id,
            tenant: record.tenant,
            scope: record.scope,
        }
        const response = await postForm(
            endpoint(settings.tenant, 'token'),
            {
                grant_type: 'refresh_token',
                client_id: settings.clientId,
                refresh_token: record.refresh_token,
                scope: settings.scope,
            },
            { timeout: TOKEN_REQUEST_TIMEOUT_MS }
        )
        return toRecord(response, settings, record)
    }
}

const PAGE_STYLE =
    'font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5'

function page(title, message) {
    const escape = s =>
        String(s).replace(
            /[&<>"']/g,
            c =>
                ({
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&#39;',
                }[c])
        )
    return (
        '<!doctype html><meta charset="utf-8"><title>' +
        escape(title) +
        '</title><body style="' +
        PAGE_STYLE +
        '"><h1>' +
        escape(title) +
        '</h1><p>' +
        escape(message) +
        '</p>'
    )
}

// Listens on the IPv4 and (when available) IPv6 loopback with the same port,
// so http://localhost reaches us whichever address the browser tries first.
async function listenLoopback(handler) {
    const servers = []
    const listen = (server, port, host) =>
        new Promise((resolve, reject) => {
            server.once('error', reject)
            server.listen(port, host, () => {
                server.off('error', reject)
                resolve(server.address().port)
            })
        })
    const v4 = Http.createServer(handler)
    const port = await listen(v4, Number(process.env.PORT) || 0, '127.0.0.1')
    servers.push(v4)
    const v6 = Http.createServer(handler)
    try {
        await listen(v6, port, '::1')
        servers.push(v6)
    } catch {
        // No IPv6 loopback, or the port is taken there; IPv4 is enough.
    }
    return {
        port,
        close: () => servers.forEach(s => s.close()),
    }
}

// Starts a browser sign-in. Resolves { url, wait, cancel }: open `url` in a
// browser; `wait` resolves with the saved token record once the browser comes
// back to the loopback listener; `cancel` stops listening.
async function startBrowserLogin(store, options = {}) {
    const settings = resolveSettings(options)
    const state = base64url(Crypto.randomBytes(16))
    const { verifier, challenge } = pkcePair()
    let settle
    const done = new Promise((resolve, reject) => {
        settle = { resolve, reject }
    })
    let redirectUri
    let handled = false

    const listener = await listenLoopback(async (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        if (url.pathname !== '/') {
            return res.writeHead(404).end()
        }
        const reply = (status, title, message) =>
            res
                .writeHead(status, {
                    'Content-Type': 'text/html; charset=utf-8',
                })
                .end(page(title, message))
        if (url.searchParams.get('state') !== state) {
            return reply(400, 'Sign-in failed', 'Unexpected sign-in response.')
        }
        // A reload of the tab replays the redirect; the code is single-use.
        if (handled) {
            return reply(200, 'Signed in', 'You can close this tab.')
        }
        handled = true
        const error = url.searchParams.get('error')
        if (error) {
            reply(
                400,
                'Sign-in failed',
                url.searchParams.get('error_description') || error
            )
            return settle.reject(
                new AuthError(error, url.searchParams.get('error_description'))
            )
        }
        try {
            const response = await postForm(
                endpoint(settings.tenant, 'token'),
                {
                    grant_type: 'authorization_code',
                    client_id: settings.clientId,
                    code: url.searchParams.get('code'),
                    redirect_uri: redirectUri,
                    code_verifier: verifier,
                    scope: settings.scope,
                }
            )
            const record = toRecord(response, settings)
            await store.write(record)
            reply(
                200,
                'Signed in',
                'onedrive-cli is signed in. You can close this tab.'
            )
            settle.resolve(record)
        } catch (err) {
            reply(500, 'Sign-in failed', err.message)
            settle.reject(err)
        }
    })

    redirectUri = 'http://localhost:' + listener.port + '/'
    const authorize = new URL(endpoint(settings.tenant, 'authorize'))
    authorize.search = new URLSearchParams({
        client_id: settings.clientId,
        response_type: 'code',
        response_mode: 'query',
        redirect_uri: redirectUri,
        scope: settings.scope,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
    }).toString()

    return {
        url: authorize.href,
        wait: done.finally(listener.close),
        cancel: listener.close,
    }
}

// Starts a device code sign-in. Resolves { verificationUri, userCode, message,
// expiresIn, wait, cancel }: show the user the code and where to enter it;
// `wait` polls until the sign-in completes and resolves with the saved record.
async function startDeviceLogin(store, options = {}) {
    const settings = resolveSettings(options)
    const device = await postForm(endpoint(settings.tenant, 'devicecode'), {
        client_id: settings.clientId,
        scope: settings.scope,
    })
    let cancelled = false
    let timer
    let wake = () => {}
    // cancel() ends the current wait early, so polling stops at once.
    const sleep = seconds =>
        new Promise(resolve => {
            wake = resolve
            timer = setTimeout(resolve, seconds * 1000)
        })

    const poll = async () => {
        let interval = Number(device.interval) || 5
        const deadline = Date.now() + Number(device.expires_in) * 1000
        while (!cancelled && Date.now() < deadline) {
            await sleep(interval)
            if (cancelled) {
                break
            }
            try {
                const response = await postForm(
                    endpoint(settings.tenant, 'token'),
                    {
                        grant_type:
                            'urn:ietf:params:oauth:grant-type:device_code',
                        client_id: settings.clientId,
                        device_code: device.device_code,
                    }
                )
                const record = toRecord(response, settings)
                await store.write(record)
                return record
            } catch (err) {
                if (err.code === 'authorization_pending') {
                    continue
                }
                if (err.code === 'slow_down') {
                    interval += 5
                    continue
                }
                throw err
            }
        }
        throw new AuthError(
            cancelled ? 'cancelled' : 'expired_token',
            cancelled ? 'Sign-in was cancelled.' : 'The sign-in code expired.'
        )
    }

    return {
        verificationUri: device.verification_uri,
        userCode: device.user_code,
        message: device.message,
        expiresIn: Number(device.expires_in),
        wait: poll(),
        cancel: () => {
            cancelled = true
            clearTimeout(timer)
            wake()
        },
    }
}

module.exports = {
    Auth,
    AuthError,
    DEFAULT_CLIENT_ID,
    DEFAULT_TENANT,
    SCOPES,
    TokenStore,
    isConsentError,
    pkcePair,
    resolveSettings,
    startBrowserLogin,
    startDeviceLogin,
}
