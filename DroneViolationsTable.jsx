import React, { useState, useMemo } from 'react';
import {
  ChevronDown, ChevronRight, ArrowUp, ArrowDown, ArrowUpDown,
  Clock, Moon, Sun, MapPin,
} from 'lucide-react';

// --- Mock data, standing in for GET /api/violations/latest + /history/:id ---

const OWNER_NAMES = [
  'Aino Koskinen', 'Mikko Virtanen', 'Liisa Nieminen', 'Jussi Mäkinen', 'Anna Hakkarainen',
  'Sami Lehtonen', 'Elina Korhonen', 'Petri Salminen', 'Hanna Laine', 'Ville Heikkinen',
  'Riikka Järvinen', 'Antti Ahonen', 'Sanna Rantanen', 'Juha Karjalainen', 'Laura Mattila',
  'Tero Turunen', 'Maria Savolainen', 'Kalle Kettunen', 'Noora Miettinen', 'Timo Piirainen',
];

const VIOLATION_TYPES = ['No-fly zone', 'Altitude breach', 'Restricted airspace', 'Signal loss', 'Speed limit'];

function makeMockData(numDrones = 28) {
  const now = Date.now();
  const drones = [];
  for (let i = 1; i <= numDrones; i++) {
    const droneId = `DRN-${String(i).padStart(3, '0')}`;
    const ownerName = OWNER_NAMES[(i - 1) % OWNER_NAMES.length];
    const historyCount = 1 + Math.floor(Math.random() * 7);
    const history = [];
    let cursor = now - Math.random() * 90 * 3600 * 1000; // most recent within last 90h
    for (let h = 0; h < historyCount; h++) {
      history.push({
        id: `${droneId}-${h}`,
        timestamp: cursor,
        type: VIOLATION_TYPES[Math.floor(Math.random() * VIOLATION_TYPES.length)],
        lat: (60.15 + (Math.random() - 0.5) * 0.3).toFixed(4),
        lng: (24.94 + (Math.random() - 0.5) * 0.3).toFixed(4),
      });
      cursor -= (1 + Math.random() * 20) * 3600 * 1000; // older entries trail further back
    }
    history.sort((a, b) => b.timestamp - a.timestamp);
    drones.push({ droneId, ownerId: `OWN-${String(i).padStart(3, '0')}`, ownerName, history });
  }
  return drones;
}

function formatRelative(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatAbsolute(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const PAGE_SIZE = 10;

const HEADERS = [
  { key: 'droneId', label: 'Drone' },
  { key: 'ownerName', label: 'Owner' },
  { key: null, label: 'Last violation type' },
  { key: 'lastViolation', label: 'Last seen' },
  { key: 'violationCount', label: 'Count' },
];

export default function DroneViolationsTable() {
  const [dark, setDark] = useState(false);
  const [data] = useState(() => makeMockData(28));
  const [rangeHours, setRangeHours] = useState(72);
  const [sortKey, setSortKey] = useState('lastViolation');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(() => new Set());

  const rows = useMemo(
    () => data.map((d) => ({ ...d, latest: d.history[0], violationCount: d.history.length })),
    [data]
  );

  const filtered = useMemo(() => {
    const cutoff = Date.now() - rangeHours * 3600 * 1000;
    return rows.filter((r) => r.latest.timestamp >= cutoff);
  }, [rows, rangeHours]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      let av, bv;
      if (sortKey === 'droneId') { av = a.droneId; bv = b.droneId; }
      else if (sortKey === 'ownerName') { av = a.ownerName; bv = b.ownerName; }
      else if (sortKey === 'violationCount') { av = a.violationCount; bv = b.violationCount; }
      else { av = a.latest.timestamp; bv = b.latest.timestamp; }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  function toggleSort(key) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('desc'); }
  }

  function toggleExpand(droneId) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(droneId) ? next.delete(droneId) : next.add(droneId);
      return next;
    });
  }

  function SortIcon({ column }) {
    if (sortKey !== column) return <ArrowUpDown className="w-3.5 h-3.5 opacity-40" />;
    return sortDir === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
      : <ArrowDown className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />;
  }

  return (
    <div className={dark ? 'dark' : ''}>
      <div className="bg-slate-50 dark:bg-slate-900 min-h-full p-6 rounded-xl transition-colors">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">Drone violations</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {sorted.length} drone{sorted.length === 1 ? '' : 's'} with violations in range
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <Clock className="w-4 h-4" />
              <span>Last {rangeHours}h</span>
              <input
                type="range" min={1} max={72} value={rangeHours}
                onChange={(e) => { setRangeHours(Number(e.target.value)); setPage(1); }}
                className="w-32 accent-sky-600"
              />
            </div>
            <button
              onClick={() => setDark((d) => !d)}
              aria-label="Toggle dark mode"
              className="p-2 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
            >
              {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
                {HEADERS.map((h) => (
                  <th key={h.label} className="text-left px-4 py-3 font-medium text-slate-500 dark:text-slate-400 select-none">
                    {h.key ? (
                      <button onClick={() => toggleSort(h.key)} className="flex items-center gap-1 hover:text-slate-800 dark:hover:text-slate-100">
                        {h.label} <SortIcon column={h.key} />
                      </button>
                    ) : h.label}
                  </th>
                ))}
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {paged.map((d) => {
                const isOpen = expanded.has(d.droneId);
                return (
                  <React.Fragment key={d.droneId}>
                    <tr
                      onClick={() => toggleExpand(d.droneId)}
                      className="border-b border-slate-100 dark:border-slate-700/50 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/30"
                    >
                      <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-100 font-mono">{d.droneId}</td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{d.ownerName}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                          {d.latest.type}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{formatRelative(d.latest.timestamp)}</td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{d.violationCount}</td>
                      <td className="px-4 py-3 text-slate-400">
                        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-slate-50 dark:bg-slate-900/40">
                        <td colSpan={HEADERS.length + 1} className="px-4 py-3">
                          <div className="pl-6 border-l-2 border-sky-200 dark:border-sky-800 space-y-2">
                            <p className="text-xs text-slate-400 dark:text-slate-500 mb-2">
                              Full history for owner {d.ownerId}
                            </p>
                            {d.history.map((h) => (
                              <div key={h.id} className="flex items-center justify-between text-sm py-1">
                                <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                                  <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                                    {h.type}
                                  </span>
                                  <span className="flex items-center gap-1 text-slate-400 dark:text-slate-500 text-xs font-mono">
                                    <MapPin className="w-3 h-3" /> {h.lat}, {h.lng}
                                  </span>
                                </div>
                                <span className="text-slate-500 dark:text-slate-400 text-xs">{formatAbsolute(h.timestamp)}</span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {paged.length === 0 && (
                <tr>
                  <td colSpan={HEADERS.length + 1} className="px-4 py-10 text-center text-slate-400">
                    No violations in this time range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between mt-4 text-sm text-slate-500 dark:text-slate-400">
          <span>Page {safePage} of {totalPages}</span>
          <div className="flex gap-2">
            <button
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 disabled:opacity-40 bg-white dark:bg-slate-800"
            >
              Prev
            </button>
            <button
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 disabled:opacity-40 bg-white dark:bg-slate-800"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
