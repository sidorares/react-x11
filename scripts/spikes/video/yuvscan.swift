// Does the render server show a YUV IOSurface set as CALayer.contents ON
// SCREEN? (CALayer.render(in:), the CPU path, rasterizes nothing for 420v or
// 2vuy — measured 2026-09-08 — which is a fact about testing, not the screen.)
//
// Ten tiles in a borderless window, each a layer: BGRA and CGImage controls,
// the two-plane (420v, 420f), packed (2vuy) and three-plane (y420, f420)
// layouts filled with one YCbCr colour, an AVSampleBufferDisplayLayer fed
// H.264 frames encoded here from solid red, and an AVPlayerLayer playing a
// .mov written here from solid magenta. Captured through the window server
// (`screencapture -l`, the same source as CGWindowListCreateImage and the
// bridge's snapshotWindow) and the centre pixel of each tile printed.
//
//   swiftc -O -swift-version 5 -o yuvscan yuvscan.swift && ./yuvscan
//
// Needs the Screen Recording right: an empty capture is the permission, not
// the layer. docs/architecture/video.md §3.4 records the result.
import AppKit
import AVFoundation
import VideoToolbox
import CoreVideo
import CoreMedia
import IOSurface

let TILE = CGSize(width: 160, height: 120)
let COLS = 5
let W = TILE.width * CGFloat(COLS)
let H = TILE.height * 2
func tileRect(_ i: Int) -> CGRect {
  CGRect(x: CGFloat(i % COLS) * TILE.width, y: CGFloat(i / COLS) * TILE.height,
         width: TILE.width, height: TILE.height)
}

func makeBuffer(_ fmt: OSType, _ w: Int, _ h: Int) -> CVPixelBuffer {
  var pb: CVPixelBuffer?
  let attrs: [CFString: Any] = [
    kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
    kCVPixelBufferPixelFormatTypeKey: fmt,
    kCVPixelBufferWidthKey: w, kCVPixelBufferHeightKey: h,
  ]
  let st = CVPixelBufferCreate(kCFAllocatorDefault, w, h, fmt, attrs as CFDictionary, &pb)
  precondition(st == kCVReturnSuccess, "CVPixelBufferCreate \(st)")
  return pb!
}

/// fill every row of a plane (or of a packed buffer when plane < 0) with a repeating byte pattern
func fill(_ pb: CVPixelBuffer, plane: Int, _ pattern: [UInt8]) {
  CVPixelBufferLockBaseAddress(pb, [])
  defer { CVPixelBufferUnlockBaseAddress(pb, []) }
  let base: UnsafeMutablePointer<UInt8>
  let bpr: Int, h: Int, w: Int
  if plane < 0 {
    base = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
    bpr = CVPixelBufferGetBytesPerRow(pb); h = CVPixelBufferGetHeight(pb); w = CVPixelBufferGetWidth(pb)
  } else {
    base = CVPixelBufferGetBaseAddressOfPlane(pb, plane)!.assumingMemoryBound(to: UInt8.self)
    bpr = CVPixelBufferGetBytesPerRowOfPlane(pb, plane)
    h = CVPixelBufferGetHeightOfPlane(pb, plane); w = CVPixelBufferGetWidthOfPlane(pb, plane)
  }
  _ = w
  for y in 0..<h { for x in 0..<bpr { base[y * bpr + x] = pattern[x % pattern.count] } }
}

func surface(_ pb: CVPixelBuffer) -> IOSurfaceRef {
  CVPixelBufferGetIOSurface(pb)!.takeUnretainedValue()
}

var keep: [Any] = []  // keep buffers alive

// --- tiles ------------------------------------------------------------------
let w = Int(TILE.width), h = Int(TILE.height)
let names = ["BGRA ctrl (blue)", "420v 2-plane (green)", "420v +colour attachments (green)", "420f 2-plane full (green)",
             "2vuy packed (green)", "y420 3-plane (green)", "f420 3-plane full (green)",
             "AVSampleBufferDisplayLayer (red)", "AVPlayerLayer (magenta)", "CGImage ctrl (orange)"]

let bgra = makeBuffer(kCVPixelFormatType_32BGRA, w, h)
fill(bgra, plane: -1, [255, 0, 0, 255])
let v420 = makeBuffer(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, w, h)
fill(v420, plane: 0, [145]); fill(v420, plane: 1, [54, 34])
let v420a = makeBuffer(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, w, h)
fill(v420a, plane: 0, [145]); fill(v420a, plane: 1, [54, 34])
CVBufferSetAttachment(v420a, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_601_4, .shouldPropagate)
CVBufferSetAttachment(v420a, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
CVBufferSetAttachment(v420a, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
IOSurfaceSetValue(surface(v420a), "IOSurfaceYCbCrMatrix" as CFString, kCVImageBufferYCbCrMatrix_ITU_R_601_4)
IOSurfaceSetValue(surface(v420a), "IOSurfaceColorSpace" as CFString, "kCGColorSpaceSRGB" as CFString)
let p2vuy = makeBuffer(kCVPixelFormatType_422YpCbCr8, w, h)
fill(p2vuy, plane: -1, [54, 145, 34, 145])
let f420 = makeBuffer(kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, w, h)
fill(f420, plane: 0, [150]); fill(f420, plane: 1, [44, 21])
let y420 = makeBuffer(kCVPixelFormatType_420YpCbCr8Planar, w, h)
fill(y420, plane: 0, [145]); fill(y420, plane: 1, [54]); fill(y420, plane: 2, [34])
let y420f = makeBuffer(kCVPixelFormatType_420YpCbCr8PlanarFullRange, w, h)
fill(y420f, plane: 0, [150]); fill(y420f, plane: 1, [44]); fill(y420f, plane: 2, [21])
keep += [bgra, v420, v420a, p2vuy, f420, y420, y420f]

// --- window -----------------------------------------------------------------
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 240, y: 240, width: W, height: H),
                      styleMask: [.borderless], backing: .buffered, defer: false)
window.level = .floating
window.isOpaque = true
window.backgroundColor = .white
final class FlippedView: NSView { override var isFlipped: Bool { true } }
let view = FlippedView(frame: NSRect(x: 0, y: 0, width: W, height: H))
view.wantsLayer = true
let root = CALayer()
root.isGeometryFlipped = true
root.backgroundColor = NSColor.white.cgColor
view.layer = root
window.contentView = view

func plain(_ i: Int, _ contents: Any?) {
  let l = CALayer()
  l.frame = tileRect(i)
  l.contentsGravity = .resize
  l.contents = contents
  root.addSublayer(l)
}
plain(0, surface(bgra))
plain(1, surface(v420))
plain(2, surface(v420a))
plain(3, surface(f420))
plain(4, surface(p2vuy))
plain(5, surface(y420))
plain(6, surface(y420f))

// 5: AVSampleBufferDisplayLayer fed H.264 frames encoded from solid red BGRA
let sbl = AVSampleBufferDisplayLayer()
sbl.frame = tileRect(7)
sbl.videoGravity = .resize
root.addSublayer(sbl)
var encoded: [CMSampleBuffer] = []
let encLock = NSLock()
var session: VTCompressionSession?
VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h), codecType: kCMVideoCodecType_H264,
                           encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
                           outputCallback: nil, refcon: nil, compressionSessionOut: &session)
if let s = session {
  VTSessionSetProperty(s, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
  VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
  VTCompressionSessionPrepareToEncodeFrames(s)
  let red = makeBuffer(kCVPixelFormatType_32BGRA, w, h)
  fill(red, plane: -1, [0, 0, 255, 255])
  keep.append(red)
  for i in 0..<30 {
    let pts = CMTime(value: CMTimeValue(i), timescale: 30)
    VTCompressionSessionEncodeFrame(s, imageBuffer: red, presentationTimeStamp: pts, duration: CMTime(value: 1, timescale: 30),
                                    frameProperties: nil, infoFlagsOut: nil) { status, _, sb in
      if status == noErr, let sb = sb { encLock.lock(); encoded.append(sb); encLock.unlock() }
    }
  }
  VTCompressionSessionCompleteFrames(s, untilPresentationTimeStamp: .invalid)
}
encLock.lock(); let frames = encoded; encLock.unlock()
print("encoded \(frames.count) H.264 frames for AVSampleBufferDisplayLayer")
for sb in frames {
  if let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: true) as? [CFMutableDictionary], let a = atts.first {
    CFDictionarySetValue(a, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                         Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
  }
  sbl.enqueue(sb)
}

// 6: AVPlayerLayer on a .mov written here (solid magenta, 3 s)
let movURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("probe-magenta.mov")
try? FileManager.default.removeItem(at: movURL)
var player: AVPlayer?
do {
  let writer = try AVAssetWriter(outputURL: movURL, fileType: .mov)
  let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h])
  let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h])
  writer.add(input)
  writer.startWriting()
  writer.startSession(atSourceTime: .zero)
  let magenta = makeBuffer(kCVPixelFormatType_32BGRA, w, h)
  fill(magenta, plane: -1, [255, 0, 255, 255])
  var i = 0
  while i < 90 {
    if input.isReadyForMoreMediaData {
      adaptor.append(magenta, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: 30)); i += 1
    } else { usleep(2000) }
  }
  input.markAsFinished()
  let done = DispatchSemaphore(value: 0)
  writer.finishWriting { done.signal() }
  done.wait()
  print("wrote \(movURL.lastPathComponent): \(writer.status == .completed ? "ok" : "status \(writer.status.rawValue)")")
  let pl = AVPlayer(url: movURL)
  let pll = AVPlayerLayer(player: pl)
  pll.frame = tileRect(8)
  pll.videoGravity = .resize
  root.addSublayer(pll)
  pl.play()
  player = pl
} catch { print("AVAssetWriter failed: \(error)") }

// 7: CGImage control, orange
do {
  let cs = CGColorSpaceCreateDeviceRGB()
  let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
  ctx.setFillColor(CGColor(red: 1, green: 0.5, blue: 0, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  plain(9, ctx.makeImage()!)
}

window.makeKeyAndOrderFront(nil)
window.orderFrontRegardless()
app.activate(ignoringOtherApps: true)

// --- capture ----------------------------------------------------------------
func capture() {
  // CGWindowListCreateImage is unavailable to Swift on this SDK; the window
  // server's composited pixels come from the screencapture tool instead,
  // which is what the docs screenshots on this machine already use.
  let out = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("yuvscan.png")
  try? FileManager.default.removeItem(at: out)
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  p.arguments = ["-x", "-o", "-l", String(window.windowNumber), out.path]
  try! p.run(); p.waitUntilExit()
  guard let data = try? Data(contentsOf: out), let rep = NSBitmapImageRep(data: data), let img = rep.cgImage else {
    print("screencapture produced nothing (exit \(p.terminationStatus)); screen-recording right missing?"); exit(2)
  }
  let iw = img.width, ih = img.height
  let scale = CGFloat(iw) / W
  print("captured \(iw)x\(ih), scale \(scale), sbl.status=\(sbl.status.rawValue) player.rate=\(player?.rate ?? -1)")
  for i in 0..<10 {
    let r = tileRect(i)
    let c = rep.colorAt(x: Int(r.midX * scale), y: Int(r.midY * scale))!.usingColorSpace(.sRGB)!
    print(String(format: "tile %d  %-34@  rgb(%3d,%3d,%3d)", i, names[i] as NSString,
                 Int(round(c.redComponent * 255)), Int(round(c.greenComponent * 255)), Int(round(c.blueComponent * 255))))
  }
  print("saved \(out.path)")
  exit(0)
}
DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { capture() }
app.run()
