"""Who verifies an issue.

A first-class column rather than a configured field: it is wanted on every
issue type on every board, and a field that always exists should not be
something each project has to remember to add.

Additive and nullable, so existing issues are simply "no tester yet" rather
than needing a backfill. Tracker Postgres only — the app's own SQLite database
is untouched by every migration in here.
"""
from alembic import op
import sqlalchemy as sa


revision = "c41d7a2b90e5"
down_revision = "6e9ca8f3ed0a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("issues", sa.Column("tester_id", sa.Integer(), nullable=True))
    # Indexed like the assignee: "what am I testing" is the same shape of
    # question as "what am I building", and it will be asked as often.
    op.create_index(op.f("ix_issues_tester"), "issues", ["tester_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_issues_tester"), table_name="issues")
    op.drop_column("issues", "tester_id")
