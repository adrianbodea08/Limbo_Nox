"""Sequence that groups the events written by one save.

Every field change is its own event row, which is what makes "when did status
become X" a plain query. But a single save usually changes several fields, and
the activity feed wants to show that as one item — "Alex changed status and
assignee" — rather than three.

A shared batch_id gives both readings from the same rows. It comes from a
sequence rather than a Python counter because several workers write at once, and
rather than the transaction id because a batch is an intent, not a transaction:
one action should stay one batch even if we later split how it is written.

Hand-written: Alembic's autogenerate does not detect sequences.
"""
from __future__ import annotations

from alembic import op

revision = "0002_event_batch_seq"
down_revision = "07f5cd3555e2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE SEQUENCE IF NOT EXISTS event_batch_seq AS BIGINT")


def downgrade() -> None:
    op.execute("DROP SEQUENCE IF EXISTS event_batch_seq")
