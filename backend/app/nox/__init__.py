"""The tracker — an in-house Jira replacement living inside this app.

Postgres-backed and optional: with no TRACKER_DATABASE_URL configured every
route here answers "not connected yet" and the rest of the app is unaffected.
See docs/tracker/DESIGN.md.
"""
