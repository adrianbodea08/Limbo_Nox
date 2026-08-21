"""asks — a question, directed at a person, about an issue, with a state

See docs/ASKS.md. The thing a comment could never be: fifty comments in this
database and not one of them is something you can be waiting on.

Revision ID: a7f2c1d9e004
Revises: e5a71b93c4d8
"""

from alembic import op
import sqlalchemy as sa

revision = "a7f2c1d9e004"
down_revision = "e5a71b93c4d8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "asks",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("issue_id", sa.BigInteger(), nullable=False),
        sa.Column("asked_by", sa.Integer(), nullable=False),
        sa.Column("asked_of", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("state", sa.String(length=16), server_default="open", nullable=False),
        sa.Column("answer", sa.Text(), server_default="", nullable=False),
        sa.Column("blocking", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("asked_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("answered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("answered_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["issue_id"], ["issues.id"],
                                name=op.f("fk_asks_issue_id"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_asks")),
    )
    # The queue: what is open, on whom, oldest first.
    op.create_index("ix_asks_of_open", "asks", ["asked_of", "state", "asked_at"],
                    unique=False)
    op.create_index("ix_asks_issue", "asks", ["issue_id", "state"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_asks_issue", table_name="asks")
    op.drop_index("ix_asks_of_open", table_name="asks")
    op.drop_table("asks")
