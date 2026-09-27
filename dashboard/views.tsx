import { useEffect, useMemo, useState } from "react";
import { api, type Card, type Meta, type Person, type SeasonResult, type ServerDetail } from "./api";
import { useDebounced, useToast } from "./hooks";
import { Avatar, Empty, Modal, Name, Progress, RarityTag, plural } from "./ui";

const PAGE = 48;

// ---------- overview ----------

export function Overview({ server, meta, onPlayer }: { server: ServerDetail; meta: Meta; onPlayer: (userId: string) => void }) {
  const pct = server.total ? Math.round((server.claimed / server.total) * 100) : 0;
  const deck = [...server.deck].reverse(); // rarest first
  return (
    <div className="overview">
      <section className="panel season-progress">
        <div className="big-line">
          <b>{server.claimed.toLocaleString()}</b>
          <span>of {server.total.toLocaleString()} cards claimed in season {server.season}</span>
        </div>
        <Progress value={server.claimed} total={server.total} />
        <p className="muted">
          {pct >= 100 ? "Every card is claimed. The season ends on the next claim check." : `${(server.total - server.claimed).toLocaleString()} left before the season ends by itself.`}
        </p>
      </section>

      <section className="panel">
        <h3>Cards by rarity</h3>
        <ul className="deck">
          {deck.map((d) => {
            const r = meta.rarities.find((x) => x.key === d.rarity);
            return (
              <li key={d.rarity}>
                <RarityTag meta={meta} rarity={d.rarity} />
                <Progress value={d.claimed} total={d.total} color={r?.color} />
                <span className="num">{d.claimed}<small> / {d.total}</small></span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="panel">
        <h3>This season</h3>
        {server.players.length ? (
          <ol className="board">
            {server.players.slice(0, 8).map((p, i) => (
              <li key={p.userId}>
                <span className="place">{i + 1}</span>
                <button className="person" onClick={() => onPlayer(p.userId)}><Avatar person={p} /><Name>{p.name}</Name></button>
                <span className="num">{p.points.toLocaleString()} <small>pts</small></span>
              </li>
            ))}
          </ol>
        ) : <Empty title="Nobody has claimed a card yet">The board fills up as players claim cards with /roll.</Empty>}
      </section>

      <section className="panel">
        <h3>All-time medals</h3>
        {server.allTime.length ? (
          <ol className="board">
            {server.allTime.map((p, i) => (
              <li key={p.userId}>
                <span className="place">{i + 1}</span>
                <span className="person static"><Avatar person={p} /><Name>{p.name}</Name></span>
                <span className="num">{p.points} <small>{plural(p.seasons, "season")}</small></span>
              </li>
            ))}
          </ol>
        ) : <Empty title="No finished seasons yet">When a season ends, its top five get permanent medal points here.</Empty>}
      </section>
    </div>
  );
}

// ---------- cards ----------

export function Cards({ server, meta, owner, setOwner, onChanged }: {
  server: ServerDetail; meta: Meta; owner: string; setOwner: (o: string) => void; onChanged: () => void;
}) {
  const [q, setQ] = useState("");
  const [rarity, setRarity] = useState("");
  const search = useDebounced(q);
  const [cards, setCards] = useState<Card[] | null>(null);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<Card | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const toast = useToast();

  const query = (offset: number) =>
    api<{ cards: Card[]; total: number }>(`/servers/${server.id}/cards?${new URLSearchParams({ q: search, rarity, owner, offset: String(offset), limit: String(PAGE) })}`);

  useEffect(() => {
    let live = true;
    setCards(null);
    query(0).then((r) => live && (setCards(r.cards), setTotal(r.total))).catch((e) => toast(e.message, "error"));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id, search, rarity, owner]);

  async function more() {
    if (!cards) return;
    setLoadingMore(true);
    try {
      const r = await query(cards.length);
      setCards([...cards, ...r.cards]);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setLoadingMore(false);
    }
  }

  function changed(card: Card) {
    setCards((cs) => cs?.map((c) => (c.id === card.id ? card : c)) ?? cs);
    setOpen(card);
    onChanged();
  }

  const ownerName = owner && owner !== "none" ? server.players.find((p) => p.userId === owner)?.name : null;
  const filtered = !!(q || rarity || owner);

  return (
    <div className="cards-view">
      <div className="toolbar">
        <label className="field grow">
          <span>Search</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Card number or name" />
        </label>
        <label className="field">
          <span>Rarity</span>
          <select value={rarity} onChange={(e) => setRarity(e.target.value)}>
            <option value="">All rarities</option>
            {[...meta.rarities].reverse().map((r) => <option key={r.key} value={r.key}>{r.key}{r.secret ? " (secret)" : ""}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Owner</span>
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Anyone or nobody</option>
            <option value="none">Unclaimed only</option>
            {server.players.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
            {owner && owner !== "none" && !ownerName && <option value={owner}>{owner}</option>}
          </select>
        </label>
      </div>

      <p className="count" aria-live="polite">
        {cards ? <>Showing {cards.length.toLocaleString()} of {plural(total, "card")}{filtered ? " that match" : ""}</> : "Loading cards…"}
        {filtered && <button className="link" onClick={() => { setQ(""); setRarity(""); setOwner(""); }}>Clear filters</button>}
      </p>

      {cards && !cards.length ? (
        <Empty title="No cards match">Try a different number or name, or clear the filters.</Empty>
      ) : (
        <ul className="card-grid">
          {(cards ?? Array.from({ length: 12 }, () => null)).map((c, i) => (
            <li key={c?.id ?? `s${i}`}>
              {c ? (
                <button className="tile" onClick={() => setOpen(c)} style={{ "--rc": meta.rarities.find((r) => r.key === c.rarity)?.color } as React.CSSProperties}>
                  <img src={`${meta.imageBase}/${c.file}`} alt="" loading="lazy" />
                  <span className="tile-body">
                    <span className="tile-id">#{c.id}</span>
                    <Name>{c.name}</Name>
                    <span className="tile-owner">{c.owner ? <><Avatar person={c.owner} size={18} /><Name>{c.owner.name}</Name></> : <span className="muted">Unclaimed</span>}</span>
                  </span>
                </button>
              ) : <span className="tile ghost" />}
            </li>
          ))}
        </ul>
      )}

      {cards && cards.length < total && (
        <div className="more"><button className="btn" onClick={more} disabled={loadingMore}>{loadingMore ? "Loading…" : `Show ${Math.min(PAGE, total - cards.length)} more`}</button></div>
      )}

      {open && <CardPanel card={open} server={server} meta={meta} onClose={() => setOpen(null)} onChanged={changed} />}
    </div>
  );
}

function CardPanel({ card, server, meta, onClose, onChanged }: {
  card: Card; server: ServerDetail; meta: Meta; onClose: () => void; onChanged: (c: Card) => void;
}) {
  const [picking, setPicking] = useState(!card.owner);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const toast = useToast();
  const r = meta.rarities.find((x) => x.key === card.rarity);

  async function give(p: Person) {
    setBusy(true);
    try {
      const res = await api<{ owner: Person }>(`/servers/${server.id}/cards/${card.id}/owner`, { method: "PUT", body: { userId: p.userId } });
      toast(`#${card.id} ${card.name} now belongs to ${res.owner.name}.`);
      onChanged({ ...card, owner: res.owner });
      setPicking(false);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      await api(`/servers/${server.id}/cards/${card.id}/owner`, { method: "DELETE" });
      toast(`#${card.id} ${card.name} is back in the pool.`);
      onChanged({ ...card, owner: null });
      setConfirmClear(false);
      setPicking(true);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Card #${card.id}`} onClose={onClose} wide>
      <div className="card-panel">
        <img className="card-big" src={`${meta.imageBase}/${card.file}`} alt="" style={{ borderColor: r?.color }} />
        <div className="card-info">
          <h3 className="card-name"><Name>{card.name}</Name></h3>
          <p className="facts"><RarityTag meta={meta} rarity={card.rarity} /><span>{plural(r?.points ?? 0, "point")}</span></p>

          <div className="owner-box">
            <span className="label">Owner in {server.name}</span>
            {card.owner ? (
              <div className="owner-row"><Avatar person={card.owner} size={36} /><Name>{card.owner.name}</Name></div>
            ) : <p className="muted">Nobody. It can be rolled and claimed.</p>}
          </div>

          {confirmClear ? (
            <div className="confirm">
              <p>Take it from <b><Name>{card.owner?.name}</Name></b> and put it back in the pool? Anyone can then roll it.</p>
              <div className="row">
                <button className="btn danger" onClick={clear} disabled={busy}>Return to pool</button>
                <button className="btn ghost" onClick={() => setConfirmClear(false)} disabled={busy}>Keep it</button>
              </div>
            </div>
          ) : picking ? (
            <MemberPicker server={server} busy={busy} onPick={give} onCancel={card.owner ? () => setPicking(false) : undefined} />
          ) : (
            <div className="row">
              <button className="btn primary" onClick={() => setPicking(true)}>Give to someone else</button>
              {card.owner && <button className="btn ghost danger-text" onClick={() => setConfirmClear(true)}>Return to pool</button>}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Find anyone in the server by name (or paste their Discord ID), with this season's players one click away. */
function MemberPicker({ server, busy, onPick, onCancel }: { server: ServerDetail; busy: boolean; onPick: (p: Person) => void; onCancel?: () => void }) {
  const [q, setQ] = useState("");
  const search = useDebounced(q, 300);
  const [found, setFound] = useState<Person[] | null>(null);

  useEffect(() => {
    if (!search.trim()) return setFound(null);
    let live = true;
    api<Person[]>(`/servers/${server.id}/members?q=${encodeURIComponent(search.trim())}`).then((r) => live && setFound(r)).catch(() => live && setFound([]));
    return () => { live = false; };
  }, [search, server.id]);

  const quick = useMemo(() => server.players.slice(0, 6), [server.players]);
  const list = found ?? quick;

  return (
    <div className="picker">
      <label className="field">
        <span>Give it to</span>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a name, or paste a Discord ID" disabled={busy} />
      </label>
      {!found && quick.length > 0 && <span className="label">Players this season</span>}
      {list.length ? (
        <ul className="people">
          {list.map((p) => (
            <li key={p.userId}>
              <button onClick={() => onPick(p)} disabled={busy}><Avatar person={p} /><Name>{p.name}</Name><span className="go">Give</span></button>
            </li>
          ))}
        </ul>
      ) : found ? <p className="muted">Nobody called “{search}” in this server. Try part of their name, or their ID.</p> : null}
      {onCancel && <button className="link" onClick={onCancel}>Cancel</button>}
    </div>
  );
}

// ---------- players ----------

export function Players({ server, onCards }: { server: ServerDetail; onCards: (userId: string) => void }) {
  const [q, setQ] = useState("");
  const top = server.players[0]?.points || 1;
  const shown = server.players.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  if (!server.players.length) return <Empty title="No players yet">Players appear here once they claim their first card this season.</Empty>;
  return (
    <div className="players-view">
      <div className="toolbar">
        <label className="field grow"><span>Find a player</span><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name" /></label>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>#</th><th>Player</th><th className="r">Cards</th><th className="r">Points</th><th className="hide-sm">Share of the leader</th><th /></tr></thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.userId}>
                <td className="place">{server.players.indexOf(p) + 1}</td>
                <td><span className="person static"><Avatar person={p} /><Name>{p.name}</Name></span></td>
                <td className="r num">{p.cards}</td>
                <td className="r num">{p.points.toLocaleString()}</td>
                <td className="hide-sm"><Progress value={p.points} total={top} /></td>
                <td className="r"><button className="btn small ghost" onClick={() => onCards(p.userId)}>See cards</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- season ----------

export function Season({ server, meta, onEnded }: { server: ServerDetail; meta: Meta; onEnded: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SeasonResult | null>(null);
  const toast = useToast();
  const medals = meta.medals;
  const top = server.players.slice(0, medals.length);

  async function end() {
    setBusy(true);
    try {
      const r = await api<SeasonResult>(`/servers/${server.id}/end-season`, { method: "POST", body: { season: server.season } });
      setResult(r);
      setAsking(false);
      onEnded();
    } catch (e) {
      toast((e as Error).message, "error");
      setAsking(false);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <section className="panel">
        <h3>Season {result.season} is over</h3>
        <p className={result.posted && result.pinged ? "ok-text" : "warn-text"}>
          {!result.posted
            ? "The results could not be posted: the bot has not been used in a channel yet, or can't send messages there."
            : result.pinged
              ? `Results posted in #${result.channel}, and @everyone was tagged.`
              : `Results posted in #${result.channel}, but @everyone was not pinged. Give the bot the “Mention @everyone” permission in that server.`}
        </p>
        <ol className="board">
          {result.medals.map((m) => (
            <li key={m.userId}><span className="place">{m.place}</span><span className="person static"><Avatar person={m} /><Name>{m.name}</Name></span><span className="num">+{m.points} <small>medal pts</small></span></li>
          ))}
        </ol>
        <p className="muted">Season {result.season + 1} has started: every card is back in the pool, and everyone's rolls and claim are reset.</p>
      </section>
    );
  }

  return (
    <div className="season-view">
      <section className="panel">
        <h3>Season {server.season}</h3>
        <p className="muted">A season ends by itself when the last card is claimed. You can also end it now.</p>
        <h4>If it ended now</h4>
        {top.length ? (
          <ol className="board">
            {top.map((p, i) => (
              <li key={p.userId}><span className="place">{i + 1}</span><span className="person static"><Avatar person={p} /><Name>{p.name}</Name></span><span className="num">+{medals[i]} <small>medal pts</small></span></li>
            ))}
          </ol>
        ) : <Empty title="Nobody has played this season">There is nothing to end yet.</Empty>}
      </section>

      <section className="panel danger-zone">
        <h3>End season {server.season} now</h3>
        <ul className="consequences">
          <li>The top {medals.length} above get their medal points, permanently.</li>
          <li>Every card goes back into the pool for season {server.season + 1}.</li>
          <li>Everyone's rolls and claim are reset right away.</li>
          <li>The bot posts the ranking in the server and tags @everyone.</li>
        </ul>
        <button className="btn danger" onClick={() => setAsking(true)} disabled={!top.length}>End season {server.season}</button>
      </section>

      {asking && (
        <Modal title={`End season ${server.season}?`} onClose={() => !busy && setAsking(false)}>
          <p>This can't be undone. <b><Name>{server.name}</Name></b> starts season {server.season + 1} straight away and everyone is tagged.</p>
          <div className="row end">
            <button className="btn ghost" onClick={() => setAsking(false)} disabled={busy}>Cancel</button>
            <button className="btn danger" onClick={end} disabled={busy}>{busy ? "Ending…" : `End season ${server.season}`}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
