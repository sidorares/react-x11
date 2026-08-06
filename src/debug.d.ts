// Hand-written declarations for `react-x11/debug` (docs/debugging.md).

export type TraceSink = 'summary' | 'requests' | 'chrome';

export interface TraceStats {
  /** Requests sent since the trace attached. */
  requests: number;
  bytesOut: number;
  /** Replies received (each one is a round trip the client waited for). */
  replies: number;
  events: number;
  errors: number;
  bytesIn: number;
  /** Decoded request name — e.g. 'CopyArea', 'Render.CompositeGlyphs32' —
   * to how many times it was sent. */
  byOpcode: Map<string, number>;
  /** ntk's rounded-rect fast path (ntk >= 6.7.0): boxes emitted as cached
   * corner glyphs + FillRectangles, against those that fell back to
   * polygon rasterization, counted by reason. Both zero on older ntk. */
  shapes: ShapeStats;
}

export interface ShapeStats {
  /** Rounded boxes drawn as corner glyphs + rects. */
  hits: number;
  /** Bail-out reason — 'fractional', 'gradient', 'clip-mask', 'dashes',
   * 'transform', 'radius-cap', 'composite-op', 'geometry', 'radii-mix',
   * 'join' — to how many draws took it. */
  misses: Record<string, number>;
}

export interface TraceOptions {
  /** Trace one specific ntk App. Without it, the trace follows every
   * connection the renderer has open or opens later. */
  app?: unknown;
  /** 'summary' (default): totals at stop. 'requests': a stderr line per
   * request and per frame. 'chrome': Trace Event JSON written to `path`. */
  sink?: TraceSink;
  /** Output file for the 'chrome' sink. Default 'react-x11-trace.json'. */
  path?: string;
  /** Capture a JS stack per request (node-x11's seq2stack), so an async X
   * error names the call that sent it. One Error capture per request. */
  seq2stack?: boolean;
}

export interface TraceSession {
  /** Live totals; the same object `stop()` returns. */
  stats: TraceStats;
  /** Detach from every connection, flush the sink, return the totals. */
  stop(): TraceStats;
}

export function startTrace(options?: TraceOptions): TraceSession;

/** What `REACT_X11_TRACE=<spec>` calls at startup. Grammar:
 * `summary` | `requests[+stacks]` | `chrome[+stacks]:<path>`. */
export function startEnvTrace(spec: string): TraceSession | null;

/** The one-line rounded-box tally the 'summary' sink prints, or null when
 * nothing drew a rounded box. */
export function formatShapes(
  shapes: ShapeStats | null | undefined,
): string | null;
