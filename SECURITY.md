# Security policy

## Reporting a vulnerability

Report privately through GitHub:
[**Report a vulnerability**](https://github.com/sidorares/react-x11/security/advisories/new)
on this repository. That opens a private advisory only the maintainers can
see.

Please do not open a public issue for something exploitable.

Useful in a report: what an attacker gets, the smallest reproduction you
have, and the versions of `react-x11`, `ntk`, `x11` and Node. If the issue
is really in [ntk](https://github.com/sidorares/ntk) or
[node-x11](https://github.com/sidorares/node-x11), say so — it can be
redirected, and all three are maintained together.

**Do not include your `~/.Xauthority` contents, `xauth list` output, or a
trace of the connection handshake.** Those are display credentials; see
[docs/security.md](docs/security.md#xauthority-is-a-password).

Expect an acknowledgement within a week. This is a volunteer project with no
paid security team and no bounty programme, and saying so is more useful than
a response-time promise nobody is on call to keep.

## What is in scope

The renderer's own behaviour: a crafted prop, style, markup string or event
that causes memory corruption in the process, executes code, escapes the
`<html>`/`<markdown>`/`<svg>` content sandbox further than documented, leaks
the X authority cookie, or lets one root interfere with another.

## What is not in scope

**X11 has no isolation between clients, by design.** Any program on a
display can read any window's pixels, synthesize input and record the
keyboard. That is not a react-x11 vulnerability and cannot be fixed here.
The full threat model is [docs/security.md](docs/security.md); the short
version is that a react-x11 window is not a confidential surface, and
`$XAUTHORITY` is a password.

Also out of scope:

- **A hostile X server.** Connecting to a display means trusting it with
  everything you draw and type. There is no protocol-level defence and no
  library can add one.
- **`ssh -Y` / `xhost +` making things worse.** Both hand your session away
  on purpose; `docs/security.md` says not to use them.
- Vulnerabilities in dependencies, unless react-x11 is what makes them
  reachable. Report those upstream (and tell us, so the floor can be
  raised).

## Supported versions

The latest published minor. This project has no long-term support branches;
a fix ships in a new release rather than as a backport.
