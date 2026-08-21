"""labels — the axis nothing else covers

Type says what kind of work it is, status where it has got to, component which
part of the system, parent what it belongs to. None of them can say "flaky",
"needs-design" or "good-first-issue".

Revision ID: c5d1e9b408aa
Revises: b3e8d5a11f27
"""

from alembic import op
import sqlalchemy as sa

revision = "c5d1e9b408aa"
down_revision = "b3e8d5a11f27"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "labels",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("key", sa.String(length=40), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("colour", sa.String(length=9), server_default="#8b949e", nullable=False),
        sa.Column("description", sa.Text(), server_default="", nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_labels")),
        sa.UniqueConstraint("key", name=op.f("uq_labels_key")),
    )
    op.create_table(
        "issue_labels",
        sa.Column("issue_id", sa.BigInteger(), nullable=False),
        sa.Column("label_id", sa.Integer(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["issue_id"], ["issues.id"],
                                name=op.f("fk_issue_labels_issue_id"),
                                ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["label_id"], ["labels.id"],
                                name=op.f("fk_issue_labels_label_id"),
                                ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("issue_id", "label_id",
                                name=op.f("pk_issue_labels")),
    )
    op.create_index("ix_issue_labels_label", "issue_labels", ["label_id"],
                    unique=False)


def downgrade() -> None:
    op.drop_index("ix_issue_labels_label", table_name="issue_labels")
    op.drop_table("issue_labels")
    op.drop_table("labels")
