import React, { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { useColorMode } from '@docusaurus/theme-common';
import useBaseUrl from '@docusaurus/useBaseUrl';
import { shareUrl } from '../../lib/share.mjs';
import styles from './styles.module.css';

const MAX_CONSOLE_LINES = 200;

// A react-x11 editor next to a live X session. The iframe hosts a
// JavaScript X server rendered to a canvas plus the whole react-x11 stack
// (static/demo/runner/); Run sends the editor contents over postMessage and
// the runner compiles the JSX and mounts it, exactly like a node program
// talking to a real display.
export default function LiveDemoImpl({
  code,
  height = 460,
  screenWidth = 640,
  screenHeight = 480,
  // Built-in demos run themselves as soon as the X server is up. Code that
  // arrived from somebody's link does not: it sits in the editor until the
  // reader has looked at it and pressed Run.
  autoRun = true,
}) {
  const { colorMode } = useColorMode();
  // directory-index URL: a bare `index.html` gets clean-URL-redirected by
  // `docusaurus serve` (losing the base path), breaking local previews
  const runnerBase = useBaseUrl('/demo/runner/');
  const runnerSrc = `${runnerBase}?width=${screenWidth}&height=${screenHeight}`;

  const iframeRef = useRef(null);
  const codeRef = useRef(code);
  const consoleRef = useRef(null);
  const [editorCode, setEditorCode] = useState(code);
  const [lines, setLines] = useState([]);
  const [ready, setReady] = useState(false);

  const run = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame || !frame.contentWindow) return;
    setLines([]);
    frame.contentWindow.postMessage(
      { type: 'run-code', code: codeRef.current },
      '*',
    );
  }, []);

  useEffect(() => {
    const onMessage = (ev) => {
      const frame = iframeRef.current;
      if (!frame || ev.source !== frame.contentWindow) return;
      const msg = ev.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        setReady(true);
        if (autoRun) run(); // once the runner has booted
      } else if (msg.type === 'console') {
        setLines((prev) => [
          ...prev.slice(-(MAX_CONSOLE_LINES - 1)),
          { level: msg.level, text: msg.text },
        ]);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [run, autoRun]);

  useEffect(() => {
    // keep the console scrolled to the latest line
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onChange = useCallback((value) => {
    codeRef.current = value;
    setEditorCode(value);
  }, []);

  const onReset = useCallback(() => {
    codeRef.current = code;
    setEditorCode(code);
    run();
  }, [code, run]);

  // Sharing packs the editor contents into the URL itself — no server, no
  // stored snippet, nothing to expire. The address bar is updated as well as
  // the clipboard, so the link is still there to copy by hand if the
  // clipboard permission is refused.
  const [shareState, setShareState] = useState(null);
  const onShare = useCallback(async () => {
    try {
      const url = await shareUrl(codeRef.current, window.location);
      window.history.replaceState(null, '', url);
      try {
        await navigator.clipboard.writeText(url);
        setShareState({ ok: true, text: 'link copied' });
      } catch {
        setShareState({ ok: true, text: 'link is in the address bar' });
      }
    } catch (err) {
      setShareState({ ok: false, text: err.message });
    }
  }, []);

  useEffect(() => {
    if (!shareState) return undefined;
    const id = setTimeout(() => setShareState(null), 4000);
    return () => clearTimeout(id);
  }, [shareState]);

  return (
    <div className={styles.container}>
      <div className={styles.editorPane}>
        <div className={styles.toolbar}>
          <button
            type="button"
            className="button button--primary button--sm"
            disabled={!ready}
            onClick={run}
          >
            Run ▶
          </button>
          <button
            type="button"
            className="button button--secondary button--sm"
            disabled={!ready}
            onClick={onReset}
          >
            Reset
          </button>
          <button
            type="button"
            className="button button--secondary button--sm"
            onClick={onShare}
            title="Put this snippet in the URL and copy it"
          >
            Share
          </button>
          <span
            className={clsx(
              styles.hint,
              shareState && !shareState.ok && styles.hintError,
            )}
          >
            {shareState
              ? shareState.text
              : ready
                ? 'runs in your browser — no X server needed'
                : 'starting X server…'}
          </span>
        </div>
        <div className={styles.editor}>
          <CodeMirror
            value={editorCode}
            height={`${height}px`}
            theme={colorMode === 'dark' ? 'dark' : 'light'}
            extensions={[javascript({ jsx: true })]}
            onChange={onChange}
            basicSetup={{ tabSize: 2 }}
          />
        </div>
        <div className={styles.console} ref={consoleRef}>
          {lines.length === 0 ? (
            <div className={styles.consoleEmpty}>console output</div>
          ) : (
            lines.map((line, i) => (
              <div
                key={i}
                className={styles[`console_${line.level}`] || undefined}
              >
                {line.text}
              </div>
            ))
          )}
        </div>
      </div>
      <div className={styles.screenPane}>
        <iframe
          ref={iframeRef}
          src={runnerSrc}
          className={styles.frame}
          style={{ aspectRatio: `${screenWidth} / ${screenHeight}` }}
          title="react-x11 live X session"
        />
        <div className={styles.screenCaption}>
          {screenWidth}×{screenHeight} X screen — click it to give it focus,
          then use the pointer and keyboard on the window
        </div>
      </div>
    </div>
  );
}
