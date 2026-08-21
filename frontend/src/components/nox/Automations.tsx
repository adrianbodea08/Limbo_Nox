// Automations — built from blocks, never from code.
//
// The builder only ever offers what the runner understands: the vocabulary
// comes from /automation/blocks rather than being written out here, so the two
// cannot drift. Pick "move to a status" and the status list is the real one.
//
// Two things share the page with the builder on purpose. The audit log, because
// a rule you cannot explain is a rule people switch off out of fear. And the
// dry run, because authoring blind and finding out on live is how automation
// loses trust the first time.

import { useEffect, useState } from "react";
import { M3Select } from "../M3Select";
import { ago, trackerApi } from "./model";
import { ArrowLeft, X } from "lucide-react";
import type {
  AutomationBlocks, AutomationRule, AutomationRun, TrackerMeta,
} from "./model";

interface Props {
  meta: TrackerMeta;
}

export function Automations({ meta }: Props) {
  const [blocks, setBlocks] = useState<AutomationBlocks | null>(null);
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function reload() {
    setRules(await trackerApi.rules());
  }

  useEffect(() => {
    trackerApi.automationBlocks().then(setBlocks).catch((e) => setError(String(e)));
    reload().catch((e) => setError(String(e)));
  }, []);

  const open = rules.find((r) => r.id === openId) ?? null;

  if (!blocks) return <p className="tk-dim">Loading…</p>;

  if (open) {
    return (
      <RuleEditor
        rule={open}
        blocks={blocks}
        meta={meta}
        onClose={() => setOpenId(null)}
        onSaved={async () => {
          await reload();
        }}
      />
    );
  }

  return (
    <div className="tk-releases">
      <div className="tk-rel-head">
        <h2>Automations</h2>
        <button
          type="button"
          className="tk-btn tk-layer tk-btn-primary"
          onClick={async () => {
            const created = await trackerApi.createRule({
              name: "New rule",
              enabled: false,
              trigger: { type: "issue_created" },
              conditions: {},
              actions: [],
            });
            await reload();
            setOpenId(created.id);
          }}
        >
          New rule
        </button>
      </div>
      {error && <p className="tk-error">{error}</p>}

      {rules.length === 0 && <p className="tk-dim">No rules yet.</p>}
      <div className="tk-rule-list">
        {rules.map((r) => {
          const trigger = blocks.triggers.find((t) => t.type === r.trigger?.type);
          return (
            <div key={r.id} className="tk-rule">
              <button type="button" className="tk-rule-main tk-layer" onClick={() => setOpenId(r.id)}>
                <span className="tk-rule-name">{r.name}</span>
                <span className="tk-dim">
                  when {trigger?.label ?? r.trigger?.type ?? "—"} · {r.actions?.length ?? 0} action
                  {(r.actions?.length ?? 0) === 1 ? "" : "s"}
                </span>
                {/* A rule that switched itself off says so here rather than
                    just looking disabled for no visible reason. */}
                {r.disabled_reason && <span className="tk-rule-warn">{r.disabled_reason}</span>}
              </button>
              <label className="tk-toggle" title={r.enabled ? "Enabled" : "Disabled"}>
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={async () => {
                    await trackerApi.patchRule(r.id, { enabled: !r.enabled });
                    reload();
                  }}
                />
                <span>{r.enabled ? "on" : "off"}</span>
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ editor --

function RuleEditor({
  rule,
  blocks,
  meta,
  onClose,
  onSaved,
}: {
  rule: AutomationRule;
  blocks: AutomationBlocks;
  meta: TrackerMeta;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<AutomationRule>(rule);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [tryOn, setTryOn] = useState("");
  const [tried, setTried] = useState<string>("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    trackerApi.ruleRuns(rule.id).then(setRuns).catch(() => {});
  }, [rule.id]);

  function set(patch: Partial<AutomationRule>) {
    setDraft((d) => ({ ...d, ...patch }));
  }

  function setAction(index: number, patch: Record<string, unknown>) {
    const actions = [...(draft.actions ?? [])];
    actions[index] = { ...actions[index], ...patch };
    set({ actions });
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      await trackerApi.patchRule(rule.id, {
        name: draft.name,
        description: draft.description,
        enabled: draft.enabled,
        trigger: draft.trigger,
        conditions: draft.conditions,
        actions: draft.actions,
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const trigger = draft.trigger ?? {};

  return (
    <div className="tk-releases">
      <div className="tk-rel-head">
        <button type="button" className="tk-btn tk-layer" onClick={onClose}><ArrowLeft size={16} aria-hidden /> Automations</button>
        <input
          className="tk-input"
          style={{ maxWidth: 380 }}
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        <button type="button" className="tk-btn tk-layer tk-btn-primary" disabled={saving} onClick={save}>
          Save
        </button>
      </div>
      {error && <p className="tk-error">{error}</p>}

      <div className="tk-rel-block">
        <h3>When</h3>
        <div className="tk-artifact-add">
          <M3Select
            value={trigger.type ?? "issue_created"}
            width={280}
            options={blocks.triggers.map((t) => ({ value: t.type, label: t.label }))}
            onChange={(v) => set({ trigger: { ...trigger, type: v } })}
          />
          {/* "moves to In Review", not "moves anywhere" — the extra field only
              appears for the trigger that needs it. */}
          {trigger.type === "issue_transitioned" && (
            <M3Select
              value={String(trigger.to_status_id ?? "")}
              width={190}
              placeholder="any status"
              options={meta.statuses.map((s) => ({ value: String(s.id), label: s.name }))}
              onChange={(v) => set({ trigger: { ...trigger, to_status_id: Number(v) } })}
            />
          )}
          {trigger.type === "issue_field_changed" && (
            <M3Select
              value={String(trigger.field ?? "")}
              width={190}
              placeholder="any field"
              options={[
                { value: "assignee_id", label: "Assignee" },
                { value: "priority", label: "Priority" },
                { value: "summary", label: "Summary" },
                ...meta.fields.map((f) => ({ value: `custom.${f.key}`, label: f.name })),
              ]}
              onChange={(v) => set({ trigger: { ...trigger, field: v } })}
            />
          )}
        </div>
        <label className="tk-runbook">
          <input
            type="checkbox"
            checked={!!trigger.allow_automated}
            onChange={(e) => set({ trigger: { ...trigger, allow_automated: e.target.checked } })}
          />
          <span className="tk-runbook-title">
            Also react to changes made by other automations
            <span className="tk-dim">
              {" "}
              — off by default, and capped at {blocks.maxDepth} hops even when on
            </span>
          </span>
        </label>
      </div>

      <div className="tk-rel-block">
        <h3>If</h3>
        <ConditionRows
          conditions={draft.conditions ?? {}}
          meta={meta}
          onChange={(conditions) => set({ conditions })}
        />
      </div>

      <div className="tk-rel-block">
        <h3>Then</h3>
        {(draft.actions ?? []).map((action, i) => (
          <div key={i} className="tk-action">
            <M3Select
              value={String(action.type ?? "")}
              width={200}
              options={blocks.actions.map((a) => ({ value: a.type, label: a.label }))}
              onChange={(v) => setAction(i, { type: v })}
            />
            <ActionFields
              action={action}
              blocks={blocks}
              meta={meta}
              onChange={(patch) => setAction(i, patch)}
            />
            <button
              type="button"
              className="tk-x tk-layer"
              onClick={() => set({ actions: (draft.actions ?? []).filter((_, j) => j !== i) })}
            ><X size={16} aria-hidden /></button>
          </div>
        ))}
        <button
          type="button"
          className="tk-link tk-layer"
          onClick={() => set({ actions: [...(draft.actions ?? []), { type: "comment", body: "" }] })}
        >
          + add an action
        </button>
        <p className="tk-dim">
          Variables: {blocks.variables.join("  ")}
        </p>
      </div>

      <div className="tk-rel-block">
        <h3>Try it</h3>
        {/* Against a real issue, and rolled back either way. */}
        <div className="tk-artifact-add">
          <input
            className="tk-search"
            style={{ width: 150 }}
            placeholder="Issue key, e.g. CD-3"
            value={tryOn}
            onChange={(e) => setTryOn(e.target.value)}
          />
          <button
            type="button"
            className="tk-btn tk-layer"
            disabled={!tryOn.trim()}
            onClick={async () => {
              setTried("");
              try {
                const issue = await trackerApi.issue(tryOn.trim().toUpperCase());
                const result = await trackerApi.dryRun(rule.id, "issue", issue.id);
                setTried(
                  result.outcome === "ran"
                    ? `Would run: ${result.steps.map((s) => s.type).join(", ") || "nothing"}`
                    : result.error
                      ? `${result.outcome}: ${result.error}`
                      : `Skipped — the conditions did not match ${issue.key}.`,
                );
              } catch (e) {
                setTried(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Dry run
          </button>
          {tried && <span className="tk-dim">{tried}</span>}
        </div>
      </div>

      <div className="tk-rel-block">
        <h3>History</h3>
        {runs.length === 0 && <p className="tk-dim">This rule has not run yet.</p>}
        {runs.map((r) => (
          <div key={r.id} className="tk-event">
            <span className={`tk-run tk-run-${r.outcome}`}>{r.outcome}</span>
            <span className="tk-event-what">
              {r.error
                ? r.error
                : r.outcome === "skipped"
                  ? "conditions did not match"
                  : r.steps.map((s) => s.created ?? s.type).join(", ") || "nothing to do"}
              {r.dry_run && <span className="tk-dim"> (dry run)</span>}
            </span>
            <span className="tk-dim tk-event-when">{ago(r.at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// The condition editor speaks the same filter language a saved view does, so
// there is one thing to learn rather than two.
function ConditionRows({
  conditions,
  meta,
  onChange,
}: {
  conditions: Record<string, unknown>;
  meta: TrackerMeta;
  onChange: (c: Record<string, unknown>) => void;
}) {
  const rows = (conditions.all as Record<string, unknown>[]) ?? [];
  const FIELDS = [
    { value: "project_id", label: "Project" },
    { value: "issue_type_id", label: "Type" },
    { value: "status_id", label: "Status" },
    { value: "priority", label: "Priority" },
    { value: "assignee_id", label: "Assignee" },
    { value: "summary", label: "Summary" },
    { value: "status_category", label: "Status category" },
    ...meta.fields.map((f) => ({ value: `custom.${f.key}`, label: f.name })),
  ];
  const OPS = ["eq", "ne", "contains", ">", ">=", "<", "<=", "is_empty", "is_not_empty"];

  function set(next: Record<string, unknown>[]) {
    onChange(next.length ? { all: next } : {});
  }

  return (
    <>
      {rows.length === 0 && <p className="tk-dim">No conditions — the rule runs every time.</p>}
      {rows.map((row, i) => (
        <div key={i} className="tk-action">
          <M3Select
            value={String(row.field ?? "")}
            width={190}
            options={FIELDS}
            onChange={(v) => set(rows.map((r, j) => (j === i ? { ...r, field: v } : r)))}
          />
          <M3Select
            value={String(row.op ?? "eq")}
            width={140}
            options={OPS.map((o) => ({ value: o, label: o.replace(/_/g, " ") }))}
            onChange={(v) => set(rows.map((r, j) => (j === i ? { ...r, op: v } : r)))}
          />
          <ValueField
            field={String(row.field ?? "")}
            value={row.value}
            meta={meta}
            onChange={(v) => set(rows.map((r, j) => (j === i ? { ...r, value: v } : r)))}
          />
          <button type="button" className="tk-x tk-layer" onClick={() => set(rows.filter((_, j) => j !== i))}><X size={16} aria-hidden /></button>
        </div>
      ))}
      <button
        type="button"
        className="tk-link tk-layer"
        onClick={() => set([...rows, { field: "priority", op: "eq", value: "high" }])}
      >
        + add a condition
      </button>
    </>
  );
}

// The value control follows the field: pick Status and you get the real
// statuses, not a box where a wrong id can be typed.
function ValueField({
  field,
  value,
  meta,
  onChange,
}: {
  field: string;
  value: unknown;
  meta: TrackerMeta;
  onChange: (v: unknown) => void;
}) {
  const options =
    field === "status_id"
      ? meta.statuses.map((s) => ({ value: String(s.id), label: s.name }))
      : field === "project_id"
        ? meta.projects.map((p) => ({ value: String(p.id), label: p.name }))
        : field === "issue_type_id"
          ? meta.issueTypes.map((t) => ({ value: String(t.id), label: t.name }))
          : field === "priority"
            ? ["highest", "high", "medium", "low", "lowest"].map((p) => ({ value: p, label: p }))
            : field === "status_category"
              ? ["todo", "in_progress", "done"].map((c) => ({ value: c, label: c.replace("_", " ") }))
              : null;

  if (options) {
    return (
      <M3Select
        value={String(value ?? "")}
        width={180}
        options={options}
        onChange={(v) => onChange(/^\d+$/.test(v) && field.endsWith("_id") ? Number(v) : v)}
      />
    );
  }
  return (
    <input
      className="tk-search"
      style={{ width: 180 }}
      value={String(value ?? "")}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ActionFields({
  action,
  blocks,
  meta,
  onChange,
}: {
  action: Record<string, unknown>;
  blocks: AutomationBlocks;
  meta: TrackerMeta;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const spec = blocks.actions.find((a) => a.type === action.type);
  if (!spec) return null;

  return (
    <>
      {spec.fields.map((f) => {
        const value = action[f.key];
        if (f.kind === "status") {
          return (
            <M3Select
              key={f.key}
              value={String(value ?? "")}
              width={170}
              placeholder="status"
              options={meta.statuses.map((s) => ({ value: String(s.id), label: s.name }))}
              onChange={(v) => onChange({ [f.key]: Number(v) })}
            />
          );
        }
        if (f.kind === "project") {
          return (
            <M3Select
              key={f.key}
              value={String(value ?? "")}
              width={170}
              placeholder="project"
              options={meta.projects.map((p) => ({ value: String(p.id), label: p.name }))}
              onChange={(v) => onChange({ [f.key]: Number(v) })}
            />
          );
        }
        if (f.kind === "issue_type") {
          return (
            <M3Select
              key={f.key}
              value={String(value ?? "")}
              width={150}
              placeholder="type"
              options={meta.issueTypes.map((t) => ({ value: String(t.id), label: t.name }))}
              onChange={(v) => onChange({ [f.key]: Number(v) })}
            />
          );
        }
        if (f.kind === "priority") {
          return (
            <M3Select
              key={f.key}
              value={String(value ?? "medium")}
              width={140}
              options={["highest", "high", "medium", "low", "lowest"].map((p) => ({
                value: p,
                label: p,
              }))}
              onChange={(v) => onChange({ [f.key]: v })}
            />
          );
        }
        if (f.kind === "choice") {
          return (
            <M3Select
              key={f.key}
              value={String(value ?? "")}
              width={190}
              options={(f.options ?? []).map((o) => ({ value: o, label: o.replace(/_/g, " ") }))}
              onChange={(v) => onChange({ [f.key]: v })}
            />
          );
        }
        if (f.kind === "bool") {
          return (
            <label key={f.key} className="tk-runbook">
              <input
                type="checkbox"
                checked={value !== false}
                onChange={(e) => onChange({ [f.key]: e.target.checked })}
              />
              <span className="tk-dim">{f.key.replace(/_/g, " ")}</span>
            </label>
          );
        }
        if (f.kind === "actions") return null; // nested blocks: edited as JSON below
        return (
          <input
            key={f.key}
            className="tk-search"
            style={{ flex: 1, minWidth: 180 }}
            placeholder={f.key.replace(/_/g, " ")}
            value={String(value ?? "")}
            onChange={(e) => onChange({ [f.key]: e.target.value })}
          />
        );
      })}
    </>
  );
}
