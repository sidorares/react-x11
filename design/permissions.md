# Permissions: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/permissions.md](../docs/permissions.md), the reference, and keep
their original headings so code comments that cite them still resolve.

## The ladder

**On Linux nothing answers yet.** The freedesktop counterparts are the
per-device portals (`org.freedesktop.portal.Camera`, `.Location`, …), which
need no bridge and are
[#466](https://github.com/sidorares/react-x11/issues/466)'s remaining half.
Until then a status query says `'unknown'` and a request rejects with a
**typed** `NoPermissionServiceError` — the signal to keep the feature behind
the answer, not a crash. `usePermission().available` is that branch as render
state.

The top rung is never chosen by naming a backend: the call asks the connection
the tree renders through whether it has an authorization API, and the cocoa
backend says so by carrying one.
