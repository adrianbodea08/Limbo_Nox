# Local secrets

Put the GitHub App's private key here as `github-app.pem` — the file GitHub
gives you when you press "Generate a private key".

Nothing in this folder is committed. The backend mounts it read-only at
`/run/tracker` and reads it through `TRACKER_GITHUB_APP_KEY_FILE`.

A file rather than an environment variable because a PEM is multi-line, and
env files turn that into a single mangled line that fails to parse with an
error nobody enjoys reading.
