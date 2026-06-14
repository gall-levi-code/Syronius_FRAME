# FRAME Auth

Shared form login and signed session validation for protected FRAME routes.

- `/auth/login` presents the mobile-friendly login form.
- `/auth/check` is used by Traefik ForwardAuth.
- `/auth/logout` clears the shared session.
- Sessions are signed, `HttpOnly`, `SameSite=Lax`, and valid for seven days by default.

The login uses Portal credentials. After validation, FRAME Auth injects the appropriate internal
Basic authorization header for existing services. Direct service ports retain their existing
service-level authentication behavior.
