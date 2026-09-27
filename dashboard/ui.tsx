import { type ReactNode, useEffect, useRef } from "react";
import type { Meta, Person } from "./api";

export function Avatar({ person, size = 28 }: { person: Pick<Person, "name" | "avatar"> | null; size?: number }) {
  if (person?.avatar) return <img className="avatar" src={person.avatar} alt="" width={size} height={size} loading="lazy" />;
  const letter = [...(person?.name ?? "?")][0]!.toUpperCase();
  return <span className="avatar blank" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">{letter}</span>;
}

/** Arabic names inside an English page: let each one pick its own direction. */
export const Name = ({ children }: { children: ReactNode }) => <bdi className="name">{children}</bdi>;

export function RarityTag({ meta, rarity }: { meta: Meta; rarity: string }) {
  const r = meta.rarities.find((x) => x.key === rarity);
  return (
    <span className="rarity" style={{ "--rc": r?.color ?? "#888" } as React.CSSProperties}>
      <i /> <bdi>{rarity}</bdi>{r?.secret && <em>secret</em>}
    </span>
  );
}

export function Progress({ value, total, color }: { value: number; total: number; color?: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <span className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${pct}%`, background: color }} />
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children && <p>{children}</p>}
    </div>
  );
}

export const Skeleton = ({ h = 120 }: { h?: number }) => <div className="skeleton" style={{ height: h }} aria-hidden="true" />;

/** A dialog that traps nothing fancy: Escape or the backdrop closes it, focus goes to it on open. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    document.body.classList.add("locked");
    return () => {
      removeEventListener("keydown", key);
      document.body.classList.remove("locked");
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={box}>
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

export function since(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days`;
}
