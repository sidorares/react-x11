// docs/architecture/video.md §3.4.1.
//
// What a JS-fed frame sink costs on Cocoa through a plain CALayer: bytes of a
// decoded frame arrive (a memcpy into a locked IOSurface stands in for the
// pipe read), the layer's contents are pointed at that surface, the
// transaction commits. Three surfaces rotate, 1920x1080, 420v against BGRA.
// Reported: process CPU per frame (user+sys, getrusage) and wall time; the
// wall time is the 60 Hz pacing of the loop, not a cost.
//
//   swiftc -O -swift-version 5 -o sinkcost sinkcost.swift && ./sinkcost
import AppKit
import CoreVideo
import IOSurface

let W = 1920, H = 1080, FRAMES = 240, RING = 3

func makeBuffer(_ fmt: OSType) -> CVPixelBuffer {
  var pb: CVPixelBuffer?
  let attrs: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
  precondition(CVPixelBufferCreate(kCFAllocatorDefault, W, H, fmt, attrs as CFDictionary, &pb) == kCVReturnSuccess)
  return pb!
}
func cpuSeconds() -> Double {
  var ru = rusage(); getrusage(RUSAGE_SELF, &ru)
  return Double(ru.ru_utime.tv_sec) + Double(ru.ru_utime.tv_usec) / 1e6 + Double(ru.ru_stime.tv_sec) + Double(ru.ru_stime.tv_usec) / 1e6
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 960, height: 540), styleMask: [.titled], backing: .buffered, defer: false)
window.level = .floating
let view = NSView(frame: window.contentView!.bounds)
view.wantsLayer = true
window.contentView = view
let layer = CALayer()
layer.frame = view.bounds
layer.contentsGravity = .resizeAspect
view.layer!.addSublayer(layer)
window.makeKeyAndOrderFront(nil)

struct Plane { let bytes: Int }
func run(_ name: String, _ fmt: OSType) {
  let ring = (0..<RING).map { _ in makeBuffer(fmt) }
  let planar = CVPixelBufferIsPlanar(ring[0])
  let planes = planar ? CVPixelBufferGetPlaneCount(ring[0]) : 1
  // the "decoded frame" as it would arrive from a decoder: one byte array per plane, tightly packed rows
  var frame: [[UInt8]] = []
  var rowBytes: [Int] = [], rows: [Int] = []
  for p in 0..<planes {
    let bpr = planar ? CVPixelBufferGetBytesPerRowOfPlane(ring[0], p) : CVPixelBufferGetBytesPerRow(ring[0])
    let h = planar ? CVPixelBufferGetHeightOfPlane(ring[0], p) : CVPixelBufferGetHeight(ring[0])
    rowBytes.append(bpr); rows.append(h)
    frame.append([UInt8](repeating: UInt8(40 * (p + 1)), count: bpr * h))
  }
  let total = frame.reduce(0) { $0 + $1.count }
  // warm up
  for i in 0..<RING { layer.contents = CVPixelBufferGetIOSurface(ring[i])!.takeUnretainedValue(); CATransaction.flush() }
  let cpu0 = cpuSeconds(), t0 = CFAbsoluteTimeGetCurrent()
  for i in 0..<FRAMES {
    let pb = ring[i % RING]
    CVPixelBufferLockBaseAddress(pb, [])
    for p in 0..<planes {
      let dst = (planar ? CVPixelBufferGetBaseAddressOfPlane(pb, p) : CVPixelBufferGetBaseAddress(pb))!
      frame[p].withUnsafeBytes { src in memcpy(dst, src.baseAddress!, rowBytes[p] * rows[p]) }
    }
    CVPixelBufferUnlockBaseAddress(pb, [])
    CATransaction.begin(); CATransaction.setDisableActions(true)
    layer.contents = CVPixelBufferGetIOSurface(pb)!.takeUnretainedValue()
    CATransaction.commit(); CATransaction.flush()
    // pace to a 60 Hz frame so the render server has a real frame per iteration
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 1.0 / 60))
  }
  let cpu = (cpuSeconds() - cpu0) / Double(FRAMES) * 1000, wall = (CFAbsoluteTimeGetCurrent() - t0) / Double(FRAMES) * 1000
  print(String(format: "%@  %5.2f MB/frame  cpu %.3f ms/frame  wall %.2f ms/frame", name as NSString, Double(total) / 1e6, cpu, wall))
}
DispatchQueue.main.async {
  run("420v 1080p", kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
  run("BGRA 1080p", kCVPixelFormatType_32BGRA)
  run("420v 1080p", kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
  run("BGRA 1080p", kCVPixelFormatType_32BGRA)
  exit(0)
}
app.run()
