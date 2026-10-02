# Video spikes

The two probes behind the measured claims in
[docs/architecture/video.md](../../../docs/architecture/video.md) §3.4 and
§3.4.1. Swift against the platform directly — no bridge, no renderer, no
React — so that what they measure is macOS and not our use of it.

- `yuvscan.swift` — whether the render server shows a YUV IOSurface set as a
  plain `CALayer`'s `contents` on screen, per pixel layout, beside an
  `AVSampleBufferDisplayLayer` and an `AVPlayerLayer`, captured through the
  window server. Needs the Screen Recording right: an empty capture is the
  permission, not the layer.
- `sinkcost.swift` — the process CPU per 1080p frame of a sink that copies
  decoded bytes into an IOSurface and repoints a layer at it, NV12 against
  BGRA.

```sh
swiftc -O -swift-version 5 -o yuvscan scripts/spikes/video/yuvscan.swift && ./yuvscan
swiftc -O -swift-version 5 -o sinkcost scripts/spikes/video/sinkcost.swift && ./sinkcost
```

Both write their scratch files (a capture, a `.mov`) into the current
directory and exit on their own.
