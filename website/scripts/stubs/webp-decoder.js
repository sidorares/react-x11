// Inert stub: image-in-browser's WebP decoder, which react-x11 imports the
// first time a WebP arrives on a runtime with no decoder of its own. ~300 KB
// minified for a format no demo shows — the same call as pngjs beside it.
// Importing it is free; `new WebPDecoder()` throws, and the <image> that
// asked logs it and shows nothing, as it would for a missing file.
'use strict';

module.exports = require('./unavailable.js')('image-in-browser (WebP)');
