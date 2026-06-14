# ADR 0009: Protected FRAME routes use a shared form-login session

- **Status:** Accepted
- **Date:** 2026-06-14

## Context

Protected FRAME tools were previously secured with service-level HTTP Basic authentication. That
works in full browsers, but it produces disruptive authentication popups and behaves poorly in
embedded browser panels used by streaming tools. Each service also prompted independently, making
the collection of FRAME tools feel fragmented.

Some FRAME routes must remain available without an interactive login, including OBS overlays,
audio listeners, galleries, Today viewers, and other explicitly public or tokenized resources.

## Decision

FRAME runs an internal `frame-auth` service and uses Traefik ForwardAuth on protected FRAME Edge
routes. An unauthenticated request is redirected to `/auth/login` with a validated relative return
URL. A successful login with the configured Portal credentials redirects the browser back to the
original route.

The login creates one HMAC-signed session cookie shared across the FRAME hostname. The cookie is
`HttpOnly`, `SameSite=Lax`, scoped to `/`, and valid for seven days by default. It is marked
`Secure` when accessed through HTTPS. The session duration is configurable from 1 to 30 days.

After validating the shared session, `frame-auth` supplies the appropriate internal authorization
header to services that retain Basic authentication. Direct service ports keep their existing
service-level authentication behavior as a development and recovery fallback.

The installer and public gateway continue to decide which routes are reachable in Hybrid mode.
Shared authentication does not make a LAN-only route publicly reachable.

## Consequences

- Users sign in once per browser and can open all protected FRAME Edge panels for the session
  duration without additional authentication popups.
- Embedded browser panels can use a normal in-page login form.
- Explicitly public, OBS, listener, and tokenized routes remain unattended and login-free.
- Logging out at `/auth/logout` clears the shared browser session.
- Rotating `FRAME_AUTH_SESSION_SECRET` invalidates all existing sessions.
- Portal credentials remain the shared identity source until FRAME adopts a multi-user identity
  provider.
