'use strict'

const assert = require('node:assert/strict')
const FS = require('node:fs')
const OS = require('node:os')
const Path = require('node:path')
const { test } = require('node:test')
const {
    QuickXorHash,
    quickXorHash,
    quickXorHashFile,
} = require('../lib/quickxorhash')

// Expected values come from an independent implementation, the Python
// `quickxorhash` package:
//   h = quickxorhash.quickxorhash(); h.update(data)
//   base64.b64encode(h.digest())
const pattern = n =>
    Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff))

const VECTORS = [
    ['empty input', Buffer.alloc(0), 'AAAAAAAAAAAAAAAAAAAAAAAAAAA='],
    ['"hello"', Buffer.from('hello'), 'aCgDG9jwBgAAAAAABQAAAAAAAAA='],
    ['1 byte', pattern(1), 'BwAAAAAAAAAAAAAAAQAAAAAAAAA='],
    ['159 bytes', pattern(159), 'GD+KGCbnJ+lXCrS00xVjSpWmgvI='],
    [
        '160 bytes (one full cycle)',
        pattern(160),
        'GD+KGCbnJ+lXCrS07BVjSpWmgvs=',
    ],
    ['161 bytes', pattern(161), 'fz+KGCbnJ+lXCrS07RVjSpWmgvs='],
    ['1000 bytes', pattern(1000), 'X4X7cC7/cVgPZMrjju+fOUsa7aY='],
    ['5000 x 0xff', Buffer.alloc(5000, 0xff), 'Yxvb2MY2trGNbWxjk8jYOc5xjnM='],
    ['1000003 bytes', pattern(1000003), 'RT7TXgQh+AD4QwDCTMQgxCD6UDg='],
]

for (const [name, data, expected] of VECTORS) {
    test('quickXorHash of ' + name, () => {
        assert.equal(quickXorHash(data), expected)
    })
}

test('chunked updates give the same hash as one update', () => {
    const data = pattern(1000003)
    for (const size of [1, 7, 160, 4093, 65536]) {
        const hash = new QuickXorHash()
        for (let i = 0; i < data.length; i += size) {
            hash.update(data.subarray(i, i + size))
        }
        assert.equal(hash.digest('base64'), 'RT7TXgQh+AD4QwDCTMQgxCD6UDg=')
    }
})

test('digest() without an encoding returns the 20 raw bytes', () => {
    const raw = new QuickXorHash().update(Buffer.from('hello')).digest()
    assert.equal(raw.length, 20)
    assert.equal(raw.toString('base64'), 'aCgDG9jwBgAAAAAABQAAAAAAAAA=')
})

test('quickXorHashFile streams a file', async () => {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), 'qxh-'))
    const file = Path.join(dir, 'data.bin')
    FS.writeFileSync(file, pattern(1000003))
    try {
        assert.equal(
            await quickXorHashFile(file),
            'RT7TXgQh+AD4QwDCTMQgxCD6UDg='
        )
    } finally {
        FS.rmSync(dir, { recursive: true, force: true })
    }
})
