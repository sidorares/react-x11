# Video spikes

The probes behind the measured claims in
[design/architecture/video.md](../../../design/architecture/video.md) §3.4,
§3.4.1 and §0.3. The two Swift ones go to the platform directly — no
bridge, no renderer, no React — so that what they measure is macOS and not
our use of it.

- `yuvscan.swift` — whether the render server shows a YUV IOSurface set as a
  plain `CALayer`'s `contents` on screen, per pixel layout, beside an
  `AVSampleBufferDisplayLayer` and an `AVPlayerLayer`, captured through the
  window server. Needs the Screen Recording right: an empty capture is the
  permission, not the layer.
- `sinkcost.swift` — the process CPU per 1080p frame of a sink that copies
  decoded bytes into an IOSurface and repoints a layer at it, NV12 against
  BGRA.
- `linuxpaths.mjs` — §0.3's table: a frame from a sink into a `<video>`'s
  surface through each Linux path — the JavaScript conversion and an Xv
  port on X11, the JavaScript conversion and the shader on a GLES render
  target — synchronised after each, at 720p and 1080p. Not Swift and not
  the platform alone: it measures react-x11's own writers, which is the
  question there. Needs `$DISPLAY` for the X11 rows (an Xv image adaptor
  for the Xv ones) and a render node for the GLES rows.

```sh
swiftc -O -swift-version 5 -o yuvscan scripts/spikes/video/yuvscan.swift && ./yuvscan
swiftc -O -swift-version 5 -o sinkcost scripts/spikes/video/sinkcost.swift && ./sinkcost
node --import tsx scripts/spikes/video/linuxpaths.mjs
```

The Swift ones write their scratch files (a capture, a `.mov`) into the
current directory; all three exit on their own.
