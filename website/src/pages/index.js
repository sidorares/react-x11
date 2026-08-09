import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';

import styles from './index.module.css';

const codeSample = `import React, { useState } from 'react';
import { createRoot } from 'react-x11';

function Counter() {
  const [n, setN] = useState(0);
  return (
    <window width={240} height={120} title="counter">
      <box style={{ flexGrow: 1, alignItems: 'center',
                    justifyContent: 'center', gap: 10 }}>
        <text style={{ fontSize: 24 }}>{String(n)}</text>
        <box
          style={{
            backgroundColor: '#2980b9',
            borderRadius: 6,
            padding: 8,
            cursor: 'pointer',
            ':hover': { backgroundColor: '#1f6693' },
          }}
          onClick={() => setN(n + 1)}
        >
          <text style={{ color: 'white' }}>+1</text>
        </box>
      </box>
    </window>
  );
}

const root = await createRoot(); // connects via $DISPLAY
root.render(<Counter />);`;

const features = [
  {
    title: 'A renderer, not a wrapper',
    body: (
      <>
        React computes what changed; react-x11 turns that into{' '}
        <strong>X11 protocol requests</strong> on a socket. No Electron, no
        browser engine, no WebView, no DOM, no native toolkit bridge —{' '}
        <code>&lt;div&gt;</code> is not an element that exists here.
      </>
    ),
  },
  {
    title: 'Flexbox and inline styles',
    body: (
      <>
        Layout is <a href="https://www.yogalayout.dev/">yoga</a>, the engine
        React Native uses. Styles are inline objects with <code>:hover</code>,{' '}
        <code>:focus</code>, <code>:active</code> and <code>:disabled</code>{' '}
        blocks that repaint one node <em>without a React render</em>, plus{' '}
        <code>'@width &gt;= 600'</code> size queries, theme tokens and
        transitions.
      </>
    ),
  },
  {
    title: 'Widgets included',
    body: (
      <>
        <code>Button</code>, <code>Select</code>, <code>Slider</code>,{' '}
        <code>Switch</code>, <code>Dialog</code>, <code>MenuBar</code>,{' '}
        <code>Tabs</code>, <code>Tree</code>, <code>SplitPane</code> and a
        virtualized <code>Table</code> — plain React over the primitives,
        themable, and nothing you could not have written yourself.
      </>
    ),
  },
  {
    title: 'The tooling you already use',
    body: (
      <>
        The standard <strong>React DevTools</strong> app, with
        highlight-on-hover into the X11 window. <strong>Fast Refresh</strong>{' '}
        hot reloading that keeps the connection, the window and your state.
        Alt+Click to open a component's source. TypeScript declarations in the
        box.
      </>
    ),
  },
  {
    title: 'Some react-three-fiber',
    body: (
      <>
        <code>&lt;mesh&gt;</code>, <code>&lt;group&gt;</code>, geometries,
        materials with textures, lights and raycast pointer events — drawn over{' '}
        <strong>indirect GLX</strong>, so the GL protocol travels the same X
        connection. Each geometry compiles to a server-side display list.
      </>
    ),
  },
  {
    title: 'JavaScript all the way down',
    body: (
      <>
        <code>npm install</code> never compiles anything, and{' '}
        <code>npm test</code> needs no X server: node-x11 ships a pure-JS X
        server that the tests render into and read pixels back from. Every
        screenshot on this site was made that way — so is the playground.
      </>
    ),
  },
];

function Feature({ title, body }) {
  return (
    <div className="col col--4">
      <div className={styles.featureCard}>
        <Heading as="h3">{title}</Heading>
        <p>{body}</p>
      </div>
    </div>
  );
}

const shots = [
  {
    src: '/img/docs/dashboard.png',
    caption: 'examples/dashboard.jsx — context theming, hooks, hover states',
  },
  {
    src: '/img/docs/tasks.png',
    caption: 'examples/tasks.jsx — useReducer, <textinput>, a scrolling <box>',
  },
  {
    src: '/img/docs/select-menu.png',
    caption: 'an open Select — a real override-redirect <popup> window',
  },
  {
    src: '/img/docs/three.png',
    caption: 'examples/three.jsx — a <Canvas3D> scene over indirect GLX',
  },
];

function Shot({ src, caption }) {
  return (
    <figure className={styles.shot}>
      <img src={useBaseUrl(src)} alt={caption} loading="lazy" />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

export default function Home() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title="React for the X Window System"
      description="react-x11 is a React renderer whose host environment is an X11 server: no DOM, no HTML, no native bridge — side effects are X11 protocol requests."
    >
      <header className={clsx('hero hero--primary', styles.heroBanner)}>
        <div className="container">
          <Heading as="h1" className="hero__title">
            {siteConfig.title}
          </Heading>
          <p className="hero__subtitle">{siteConfig.tagline}</p>
          <div className={styles.buttons}>
            <Link
              className="button button--secondary button--lg"
              to="/docs/intro"
            >
              Get started
            </Link>
            <Link
              className="button button--outline button--secondary button--lg"
              to="/playground"
            >
              Try it in your browser
            </Link>
            <Link
              className="button button--outline button--secondary button--lg"
              to="https://github.com/sidorares/react-x11"
            >
              GitHub
            </Link>
          </div>
        </div>
      </header>
      <main>
        <section className={styles.pitch}>
          <div className="container">
            <div className="row">
              <div className={clsx('col col--5', styles.codeIntro)}>
                <Heading as="h2">Build desktop UIs with React</Heading>
                <p>
                  Write components, hooks and flexbox; get a window on a Linux
                  desktop, on macOS under XQuartz, or on a display forwarded
                  over ssh. Only <code>&lt;window&gt;</code>,{' '}
                  <code>&lt;popup&gt;</code> and <code>&lt;glarea&gt;</code> are
                  real X windows — everything else is a retained node painted
                  into its window's double-buffered context, so a thousand-row
                  table is a layout pass, not a thousand X resources.
                </p>
                <p>
                  <Link to="/docs/intro">What react-x11 is →</Link>
                </p>
                <p>
                  <Link to="/docs/reference">Browse the API reference →</Link>
                </p>
                <p>
                  <Link to="/playground">
                    Run it here — no X server needed →
                  </Link>
                </p>
              </div>
              <div className="col col--7">
                <CodeBlock language="jsx">{codeSample}</CodeBlock>
              </div>
            </div>
          </div>
        </section>
        <section className={styles.wire}>
          <div className="container">
            <div className="row">
              <div className="col col--7">
                <Heading as="h2">The wire carries drawing, not pixels</Heading>
                <p>
                  Every renderer has to decide what to send. react-x11 does not
                  rasterize a frame on the client and ship the buffer across:
                  React reconciles the component tree, the renderer turns that
                  diff into <strong>drawing operations</strong> — rounded
                  rectangles, composited gradients, clip regions, runs of glyph
                  indices — and the X server executes them. The server owns the
                  pixels; the client never had them.
                </p>
                <p>
                  Text is shaped once and its glyphs uploaded once, so drawing a
                  line afterwards names them by index — about a byte per glyph.
                  Gradients, scaling, alpha compositing and clipping are single
                  server-side requests rather than loops over a pixel array, and
                  nothing is read back. An update costs what the{' '}
                  <em>drawing</em> costs, not what the window's area costs,
                  which is why this stays comfortable on a display forwarded
                  over ssh.
                </p>
                <p>
                  <Link to="/docs/intro#the-wire-carries-drawing-not-pixels">
                    How that works, and how it is measured →
                  </Link>
                </p>
              </div>
              <div className={clsx('col col--5', styles.wireAside)}>
                <div className={styles.benchCard}>
                  <div className={styles.benchTitle}>npm run bench</div>
                  <p>
                    Because protocol cost is the design, it is measured rather
                    than assumed. The benchmark reports requests, bytes,
                    replies, RENDER composites and{' '}
                    <strong>the pixel area those composites touch</strong>,
                    against a checked-in baseline that a pull request has to
                    update in the same diff.
                  </p>
                  <p className={styles.benchNote}>
                    That last metric exists because the others hide the most
                    common regression: a change that adds almost nothing to the
                    wire while multiplying the server's work.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section className={styles.features}>
          <div className="container">
            <div className="row">
              {features.map((props) => (
                <Feature key={props.title} {...props} />
              ))}
            </div>
          </div>
        </section>
        <section className={styles.gallery}>
          <div className="container">
            <Heading as="h2">Rendered by the code it documents</Heading>
            <p className={styles.galleryIntro}>
              Every shot below comes out of the repo's own examples, driven
              through the real event pipeline against an in-process X server and
              read back pixel by pixel.
            </p>
            <div className={styles.shots}>
              {shots.map((shot) => (
                <Shot key={shot.src} {...shot} />
              ))}
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
