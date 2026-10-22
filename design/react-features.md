# React features: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/react-features.md](../docs/react-features.md), the
reference, and keep their original headings so code comments that cite them
still resolve.

Where a heading is also in the reference, what is here is the original text
of the paragraphs the reference tightened: the mechanism, history and
rationale behind the behaviour it describes.

Everything on this page is also something you can drive by hand — in the
apps that depend on it rather than in a panel of its own:

```sh
npm run examples:monitor      # priority: a filter over ~780 live rows
npm run examples:chat         # <Activity>, useOptimistic, <Suspense>
npm run examples:timer        # error boundaries, and where a crash is logged
```

Those replaced an `examples/react-features.jsx` that had a panel per feature.
A panel proves the API exists; it cannot show you the choice, because nothing
in it costs anything. `monitor`'s field is expensive because a process list
is expensive, and that is the only condition under which deferring it is a
decision rather than a demonstration.

## Effects, and the paint boundary

That holds for a correction computed from React state. One computed from
**geometry** is a layout behind: a layout effect runs after the commit and
before the layout pass, so `abs` there is still the previous frame's rect
(zeros, on mount), and anything measured from it describes the frame
before. For a size, let the element report it with `onLayout`
([below](../docs/react-features.md#measuring-a-node)); for a style that depends on one, write a
container query ([styling.md](../docs/styling.md#container-queries)), which the
pass answers in the same frame. `scrollIntoView` measures nothing when you
call it, and neither does the part of a `scrollTo` past the extent the last
pass measured, which is what `scrollTo(Infinity)` asks for when it follows
rows this commit added. The pass answers both against the geometry it
produces, so they are safe here ([elements.md](../docs/elements.md#scrolling)).
