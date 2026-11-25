# Image decoding: AVIF under Node

Notes behind `docs/elements.md` "Formats, and what decodes them".

## Options measured (2026-11-25, node 26, M-series mac)

Real files from humanai.au: logo 250x80 (4 KB), a card 250x64 (2 KB), the
hero portrait "ASCII Face" 679x845 (55 KB, alpha).

| option                             | logo | portrait | notes                                  |
| ---------------------------------- | ---- | -------- | -------------------------------------- |
| `@jsquash/avif` main thread        | 6ms  | 60ms     | cold: +25ms module compile, 7ms init   |
| `@jsquash/avif` in the decode pool | 5ms  | 58ms     | the JavaScript thread holds none of it |
| `Bun.Image` (ImageIO), for scale   | 6ms  | 11ms     | macOS/Windows only                     |

Install size: 8 MB unpacked, 1.1 MB of it the decoder's wasm (Apache-2.0).

## Why WebAssembly

- ImageIO through `@windowkit/appkit` is the faster rung on a Mac, but
  appkit has no image-decode verb today (`CGImageSource` is not bound), it
  would be macOS only, and it still leaves Linux and Windows-under-Node with
  nothing. A verb would be a later, additive rung above this one.
- The package is an `optionalDependency` and imported on first use: an app
  that shows no AVIF never evaluates it, and one that lacks it gets an error
  that names `npm install @jsquash/avif`.

## Traps

- jsquash's default loader `fetch`es its wasm, which Node cannot do for a
  file path: the module is compiled from the file beside the package and
  handed to `init`.
- A Buffer's `slice` is a view. `bytes.slice().buffer` is the whole pool, and
  libavif decoded a 40-byte prefix of a file into the full picture because
  the pool held the rest of it.
- It decodes 8-bit RGBA only (`bitDepth` defaults to 8); 10-bit sources are
  reduced by libavif, HDR is not tone-mapped.
