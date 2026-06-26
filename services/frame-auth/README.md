# FRAME Auth

FRAME Auth provides the shared sign-in page for protected FRAME tools.

It lets you sign in once with your FRAME Portal username and password, then move between protected pages without logging in again every time.

## Who This Is For

FRAME Auth is for operators who expose FRAME through FRAME Edge and want a simple login screen in front of private control pages.

Use this if you want to protect:

- FRAME Portal
- Stream Management
- Overlay Wizard
- Photo Stage controls
- Upload/admin pages
- Other local-only FRAME management pages

Most viewers, uploaders, or public guests should never need to know this service exists.

## What You Use It For

FRAME Auth gives FRAME a shared login flow.

You normally use it when:

- Opening a protected FRAME page through your normal FRAME address.
- Signing in with your Portal credentials.
- Signing out when you are done using a shared machine.
- Keeping public links away from private setup and control pages.

The sign-in page lives at:

```text
/auth/login
```

The sign-out page lives at:

```text
/auth/logout
```

Most users should not open Auth directly unless they are signing in or signing out.

## How To Install

FRAME Auth is included with the normal FRAME stack.

In most setups, you do not install it separately. It is created and configured by the FRAME installer alongside FRAME Edge.

During setup, make sure you have Portal credentials configured:

```text
PORTAL_USERNAME
PORTAL_PASSWORD
```

These are the username and password used for the shared login screen.

The installer also creates the private session secret used by FRAME Auth. You normally do not need to edit it.

## How To Operate

Open a protected FRAME page through your normal FRAME address.

If the page needs login, FRAME will send you to the sign-in screen. Enter your Portal username and password.

After signing in, that browser stays logged in for the configured session length. The default is seven days.

To sign out, open:

```text
/auth/logout
```

Use sign out when working from a shared computer, event laptop, or borrowed browser profile.

## Relies Upon

FRAME Auth relies upon:

- FRAME Edge, which sends protected requests through the login check.
- FRAME Portal credentials, which are used for the shared login.
- FRAME Stream Management credentials, when Stream Management is protected.
- FRAME Overlay Wizard credentials, when Overlay Wizard is protected.

FRAME Auth is meant to sit behind FRAME Edge. Direct service ports may still use their own login behavior and should usually stay local.

## Notes For Operators

If login keeps looping, check that you are using the same browser address each time. Switching between different hostnames, IP addresses, or domains can make the browser treat the login as a different site.

If everyone is suddenly logged out, the session secret may have changed. This is expected after replacing or regenerating that secret.

If Portal credentials are blank, protected login will not work correctly. Set the Portal username and password before using Hybrid or public-facing access.

The session length can be changed with:

```text
FRAME_AUTH_SESSION_DAYS
```

Use a value from 1 to 30 days.

For event machines, shorter sessions are safer. For a private studio workstation, the default is usually fine.
