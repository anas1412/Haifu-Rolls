import { useEffect, useMemo, useState } from "react";
import { ApiError, api } from "./api";
import { useToast } from "./hooks";
import { Empty, Modal, Skeleton } from "./ui";

type Field = { key: string; group: string; label: string; help: string; type: "int" | "number" | "bool" | "rarity"; min?: number; max?: number; unit?: string };
type Values = Record<string, unknown> & { medalPoints: number[]; tiers: Record<string, { weight: number; points: number; claimHours: number }> };
type Payload = {
  scope: string;
  fields: Field[];
  rarities: { key: string; secret: boolean; color: string }[];
  overrides: Record<string, unknown>;
  inherited: Values;
  effective: Values;
};

const TIER_COLS = [
  { key: "weight", label: "Odds weight", help: "Per card. Higher means it rolls more often." },
  { key: "points", label: "Points", help: "What the card adds to a player's season score." },
  { key: "claimHours", label: "Wait after claiming", help: "Hours before that player can claim again." },
] as const;

/**
 * The form keeps every box as text, keyed by path ("claimWindowSeconds", "tiers.الملكة.points",
 * "medalPoints.0"). An empty box means "inherit"; only filled boxes are saved as overrides.
 */
type Draft = Record<string, string>;

function toDraft(o: Record<string, unknown>): Draft {
  const d: Draft = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "tiers") for (const [r, t] of Object.entries(v as Record<string, Record<string, number>>)) for (const [c, n] of Object.entries(t)) d[`tiers.${r}.${c}`] = String(n);
    else if (k === "medalPoints") (v as number[]).forEach((n, i) => (d[`medalPoints.${i}`] = String(n)));
    else d[k] = String(v);
  }
  return d;
}

function fromDraft(d: Draft, fields: Field[], inherited: Values): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = d[f.key];
    if (v === undefined || v === "") continue;
    out[f.key] = f.type === "bool" ? v === "true" : f.type === "rarity" ? v : Number(v);
  }
  const medals = inherited.medalPoints.map((n, i) => d[`medalPoints.${i}`]);
  if (medals.some((v) => v !== undefined && v !== "")) {
    out.medalPoints = medals.map((v, i) => (v === undefined || v === "" ? inherited.medalPoints[i] : Number(v)));
  }
  const tiers: Record<string, Record<string, number>> = {};
  for (const [k, v] of Object.entries(d)) {
    if (!k.startsWith("tiers.") || v === "") continue;
    const [, r, c] = k.split(".");
    (tiers[r!] ??= {})[c!] = Number(v);
  }
  if (Object.keys(tiers).length) out.tiers = tiers;
  return out;
}

const show = (v: unknown) => (v === true ? "Yes" : v === false ? "No" : String(v));

export function SettingsForm({ scope, serverName }: { scope: "global" | string; serverName?: string }) {
  const path = scope === "global" ? "/settings/global" : `/servers/${scope}/settings`;
  const [data, setData] = useState<Payload | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [askReset, setAskReset] = useState(false);
  const [loadError, setLoadError] = useState("");
  const toast = useToast();
  const isGlobal = scope === "global";
  const from = isGlobal ? "default" : "global";

  useEffect(() => {
    setData(null);
    api<Payload>(path).then((p) => { setData(p); setDraft(toDraft(p.overrides)); setErrors({}); }).catch((e) => setLoadError(e.message));
  }, [path]);

  const saved = useMemo(() => (data ? toDraft(data.overrides) : {}), [data]);
  const dirty = useMemo(() => {
    const keys = new Set([...Object.keys(saved), ...Object.keys(draft)]);
    return [...keys].some((k) => (saved[k] ?? "") !== (draft[k] ?? ""));
  }, [saved, draft]);

  if (loadError) return <Empty title="Couldn't load the settings">{loadError}</Empty>;
  if (!data) return <Skeleton h={420} />;

  const set = (k: string, v: string) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setErrors((e) => { const { [k]: _, ...rest } = e; return rest; });
  };
  const inheritedOf = (k: string): unknown => {
    if (k.startsWith("tiers.")) { const [, r, c] = k.split("."); return data.inherited.tiers[r!]![c as "points"]; }
    if (k.startsWith("medalPoints.")) return data.inherited.medalPoints[Number(k.split(".")[1])];
    return data.inherited[k];
  };

  async function save(next: Draft) {
    setBusy(true);
    try {
      const p = await api<Payload>(path, { method: "PUT", body: { overrides: fromDraft(next, data!.fields, data!.inherited) } });
      setData(p);
      setDraft(toDraft(p.overrides));
      setErrors({});
      toast(isGlobal ? "Global settings saved. Every server that doesn't override them uses these now." : `Settings saved for ${serverName}. They apply straight away.`);
    } catch (e) {
      const err = e as ApiError;
      setErrors(err.errors ?? {});
      toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  }

  const groups = [...new Set(data.fields.map((f) => f.group))];
  const changed = (k: string) => (draft[k] ?? "") !== "";

  const box = (k: string, f: { type: Field["type"]; min?: number; max?: number; unit?: string }) => {
    const common = { id: `s-${k}`, className: changed(k) ? "set" : "", disabled: busy, "aria-invalid": !!errors[k] || undefined };
    if (f.type === "bool") {
      return (
        <select {...common} value={draft[k] ?? ""} onChange={(e) => set(k, e.target.value)}>
          <option value="">Same as {from} ({show(inheritedOf(k))})</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    }
    if (f.type === "rarity") {
      return (
        <select {...common} value={draft[k] ?? ""} onChange={(e) => set(k, e.target.value)}>
          <option value="">Same as {from} ({show(inheritedOf(k))})</option>
          {data.rarities.map((r) => <option key={r.key} value={r.key}>{r.key}{r.secret ? " (secret)" : ""}</option>)}
        </select>
      );
    }
    return (
      <span className="num-input">
        <input {...common} type="number" inputMode="decimal" step={f.type === "int" ? 1 : "any"} min={f.min} max={f.max}
          value={draft[k] ?? ""} placeholder={`${show(inheritedOf(k))} (${from})`} onChange={(e) => set(k, e.target.value)} />
        <small>{f.unit}</small>{/* always there, so every box lines up whether it has a unit or not */}
      </span>
    );
  };

  const hint = (k: string) => errors[k]
    ? <span className="field-error" role="alert">{errors[k]}</span>
    : changed(k) ? <button type="button" className="link" onClick={() => set(k, "")}>Use {from} ({show(inheritedOf(k))})</button> : null;

  return (
    <div className="settings">
      <p className="muted settings-intro">
        {isGlobal
          ? "These apply to every server, unless a server changes them in its own Settings tab. Leave a box empty to keep the default."
          : <>These apply to <b>{serverName}</b> only. Leave a box empty to follow the global setting. Changes apply straight away.</>}
      </p>

      {groups.map((g) => (
        <section key={g} className="panel">
          <h3>{g}</h3>
          <div className="setting-rows">
            {data.fields.filter((f) => f.group === g).map((f) => (
              <div key={f.key} className={`setting${changed(f.key) ? " is-set" : ""}`}>
                <label htmlFor={`s-${f.key}`}><b>{f.label}</b>{f.help && <span>{f.help}</span>}</label>
                <div className="setting-input">{box(f.key, f)}{hint(f.key)}</div>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section className="panel">
        <h3>Season medals</h3>
        <p className="muted">Permanent points the top players get when a season ends.</p>
        <div className="medals-row">
          {data.inherited.medalPoints.map((_, i) => (
            <label key={i} className="medal-box">
              <span>Place {i + 1}</span>
              {box(`medalPoints.${i}`, { type: "int", min: 0, max: 1000 })}
            </label>
          ))}
        </div>
        {errors.medalPoints && <p className="field-error" role="alert">{errors.medalPoints}</p>}
      </section>

      <section className="panel">
        <h3>Rarities</h3>
        <p className="muted">Each rarity's odds, value, and the wait after claiming one. Names and colours are fixed in the code.</p>
        <div className="table-wrap flat">
          <table className="table tiers-table">
            <thead>
              <tr><th>Rarity</th>{TIER_COLS.map((c) => <th key={c.key} title={c.help}>{c.label}<small>{c.help}</small></th>)}</tr>
            </thead>
            <tbody>
              {[...data.rarities].reverse().map((r) => (
                <tr key={r.key}>
                  <td><span className="rarity" style={{ "--rc": r.color } as React.CSSProperties}><i /> <bdi>{r.key}</bdi>{r.secret && <em>secret</em>}</span></td>
                  {TIER_COLS.map((c) => {
                    const k = `tiers.${r.key}.${c.key}`;
                    return (
                      <td key={c.key}>
                        {box(k, { type: c.key === "points" ? "int" : "number", min: 0, unit: c.key === "claimHours" ? "h" : undefined })}
                        {errors[k] && <span className="field-error" role="alert">{errors[k]}</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="settings-foot">
        <button type="button" className="btn ghost danger-text" onClick={() => setAskReset(true)} disabled={busy || !Object.keys(saved).length}>
          {isGlobal ? "Reset everything to the defaults" : "Reset this server to the global settings"}
        </button>
      </div>

      {dirty && (
        <div className="save-bar" role="region" aria-label="Unsaved changes">
          <span>You have unsaved changes.</span>
          <button type="button" className="btn ghost" onClick={() => { setDraft(saved); setErrors({}); }} disabled={busy}>Discard</button>
          <button type="button" className="btn primary" onClick={() => save(draft)} disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
        </div>
      )}

      {askReset && (
        <Modal title={isGlobal ? "Reset to the defaults?" : "Reset to the global settings?"} onClose={() => !busy && setAskReset(false)}>
          <p>{isGlobal
            ? "Every global change is removed, and the game goes back to the values in the code. Servers keep their own changes."
            : <>Every change made for <b>{serverName}</b> is removed, and it follows the global settings again.</>}</p>
          <div className="row end">
            <button className="btn ghost" onClick={() => setAskReset(false)} disabled={busy}>Cancel</button>
            <button className="btn danger" onClick={async () => { await save({}); setAskReset(false); }} disabled={busy}>Reset</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
