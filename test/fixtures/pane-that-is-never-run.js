// A `<Frame src>` for tests that assert nothing is ever started. If this
// module is imported by a pane process, the test that named it is wrong.
export default function NeverRun() {
  throw new Error('this pane was not supposed to run');
}
