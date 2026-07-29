// Inert stub: pngjs' browser build drags in a whole browserify polyfill
// forest (zlib/stream/util/assert); PNG decoding is not needed by the
// playground demos, so loadImage()/decodeImage() of PNG data throws here.
// JPEG decoding (jpeg-js, pure JS) still works.
'use strict';

class PNG {
  constructor() {
    throw new Error('PNG decoding is not available in the playground bundle');
  }
}
PNG.sync = {
  read() {
    throw new Error('PNG decoding is not available in the playground bundle');
  },
  write() {
    throw new Error('PNG encoding is not available in the playground bundle');
  },
};

module.exports = { PNG };
