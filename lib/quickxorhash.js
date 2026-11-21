'use strict'

// QuickXorHash, the content hash that OneDrive for Business and SharePoint
// report for every file (`file.hashes.quickXorHash`). Personal OneDrive reports
// it too, alongside the older `sha1Hash`. Reference algorithm:
// https://learn.microsoft.com/onedrive/developer/code-snippets/quickxorhash
//
// The reference rotates every input byte into a 160-bit register at a bit
// offset that advances by 11 per byte, wrapping at 160. Because 11 * 160 is a
// multiple of 160, the offset depends only on the byte's position modulo 160.
// So this keeps 160 one-byte accumulators (one per position class) and does
// the bit placement once, in digest(). That is the same result as the
// reference, with a plain XOR per input byte. Finally the total length, as a
// 64-bit little-endian integer, is XORed into the last 8 bytes of the register.

const fs = require('fs')

const WIDTH_BITS = 160
const SHIFT = 11
const WIDTH_BYTES = WIDTH_BITS / 8

class QuickXorHash {
    constructor() {
        this.acc = new Uint8Array(WIDTH_BITS)
        this.phase = 0
        this.length = 0
    }

    update(data) {
        const acc = this.acc
        let k = this.phase
        for (let i = 0; i < data.length; i++) {
            acc[k] ^= data[i]
            if (++k === WIDTH_BITS) {
                k = 0
            }
        }
        this.phase = k
        this.length += data.length
        return this
    }

    // Returns a Buffer, or a string when an encoding is given (OneDrive
    // reports the hash as base64).
    digest(encoding) {
        const reg = new Uint8Array(WIDTH_BYTES)
        for (let k = 0; k < WIDTH_BITS; k++) {
            const b = this.acc[k]
            if (b === 0) {
                continue
            }
            const offset = (k * SHIFT) % WIDTH_BITS
            const index = offset >> 3
            const spread = b << (offset & 7)
            reg[index] ^= spread & 0xff
            // Bits past bit 159 wrap around to bit 0.
            reg[(index + 1) % WIDTH_BYTES] ^= spread >> 8
        }
        const length = Buffer.alloc(8)
        length.writeBigUInt64LE(BigInt(this.length))
        for (let i = 0; i < 8; i++) {
            reg[WIDTH_BYTES - 8 + i] ^= length[i]
        }
        const out = Buffer.from(reg)
        return encoding ? out.toString(encoding) : out
    }
}

function quickXorHash(data) {
    return new QuickXorHash().update(data).digest('base64')
}

// Streams the file, so large files are never held in memory.
function quickXorHashFile(path) {
    return new Promise((resolve, reject) => {
        const hash = new QuickXorHash()
        fs.createReadStream(path)
            .on('data', chunk => hash.update(chunk))
            .on('error', reject)
            .on('end', () => resolve(hash.digest('base64')))
    })
}

module.exports = { QuickXorHash, quickXorHash, quickXorHashFile }
