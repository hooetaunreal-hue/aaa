import React, { useState, useMemo } from 'react';
import {
  ChevronDown, ChevronRight, ArrowUp, ArrowDown, ArrowUpDown,
  Clock, Moon, Sun, MapPin, AlertCircle, Loader2,
} from 'lucide-react';
// Adjust this import to wherever these actually live in your app.
import { useUniqueDrones, useOwner } from '@/hooks/drones';

const PAGE_SIZE = 10;

const HEADERS = [
  { key: 'droneId', label: 'Drone' },
  { key: 'ownerName', label: 'Owner' },
  { key: null, label: 'Position' },
  { key: 'lastViolation', label: 'Last seen' },
];

// Maps one raw backend row onto what the table needs.
// raw.ssn / raw.pn are intentionally left out here — a violations table doesn't
// need full SSNs sitting in browser state and devtools. If a specific field
// ever needs to show up in the UI, mask it before it enters state, e.g.
// `ssn.slice(-4).padStart(ssn.length, '\u2022')`, rather than carrying it in full.
function normalizeRow(raw) {
  return {
    droneId: raw.drone_id,
    ownerId: raw.owner_id,
    ownerName: `${raw.first_name ?? ''} ${raw.last_name ?? ''}`.trim() || 'Unknown owner',
    x: raw.x,
    y: raw.y,
    z: raw.z,
    timestamp: new Date(raw.timestamp).getTime(),
  };
}

function normalizeHistoryEntry(raw) {
  return {
    id: `${raw.drone_id}-${raw.timestamp}`,
    droneId: raw.drone_id,
    x: raw.x,
    y: raw.y,
    z: raw.z,
    timestamp: new Date(raw.timestamp).getTime(),
  };
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

// Only ever mounted while its parent row is expanded — that mount is the
// fetch trigger. useOwner's own query cache (keyed on ownerId) does the
// "fetch once per owner, reuse across their other drones and across
// collapse/re-expand" work that historyCache/loadingOwners/errorOwners used
// to do by hand. Keep this as a real component (not an inline function
// defined inside the table's render) — redefining it every render would
// make React remount it on every parent re-render instead of caching.
function DroneHistoryRow({ droneId, ownerId, ownerName, colSpan }) {
  const { data, isLoading, isError, refetch } = useOwner(ownerId);

  const history = useMemo(
    () => (data ?? []).map(normalizeHistoryEntry).filter((h) => h.droneId === droneId),
    [data, droneId]
  );

  return (
    <tr className="bg-slate-50 dark:bg-slate-900/40">
      <td colSpan={colSpan} className="px-4 py-3">
        <div className="pl-6 border-l-2 border-sky-200 dark:border-sky-800 space-y-2">
          <p className="text-xs text-slate-400 dark:text-slate-500 mb-2">
            Full history for {ownerName}
          </p>

          {isLoading && (
            <div className="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500 py-1">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading history...
            </div>
          )}

          {isError && (
            <div className="flex items-center gap-2 text-xs text-red-500 py-1">
              <AlertCircle className="w-3.5 h-3.5" />
              Couldn't load history.
              <button
                onClick={(e) => { e.stopPropagation(); refetch(); }}
                className="underline"
              >
                Retry
              </button>
            </div>
          )}

          {!isLoading && !isError && (
            history.length === 0 ? (
              <p className="text-xs text-slate-400 dark:text-slate-500 py-1">
                No other entries for this drone.
              </p>
            ) : (
              history.map((h) => (
                <div key={h.id} className="flex items-center justify-between text-sm py-1">
                  <span className="flex items-center gap-1 text-slate-400 dark:text-slate-500 text-xs font-mono">
                    <MapPin className="w-3 h-3" /> x:{h.x} y:{h.y} z:{h.z}
                  </span>
                  <span className="text-slate-500 dark:text-slate-400 text-xs">{formatAbsolute(h.timestamp)}</span>
                </div>
              ))
            )
          )}
        </div>
      </td>
    </tr>
  );
}

export default function DroneViolationsTable() {
  const [dark, setDark] = useState(false);

  const {
    data: rawRows,
    isLoading: initialLoading,
    isError: initialIsError,
    error: initialError,
    refetch: refetchDrones,
  } = useUniqueDrones();

  const rows = useMemo(() => (rawRows ?? []).map(normalizeRow), [rawRows]);

  const [rangeHours, setRangeHours] = useState(72);
  const [sortKey, setSortKey] = useState('lastViolation');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(() => new Set());

  const filtered = useMemo(() => {
    const cutoff = Date.now() - rangeHours * 3600 * 1000;
    return rows.filter((r) => r.timestamp >= cutoff);
  }, [rows, rangeHours]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      let av, bv;
      if (sortKey === 'droneId') { av = a.droneId; bv = b.droneId; }
      else if (sortKey === 'ownerName') { av = a.ownerName; bv = b.ownerName; }
      else { av = a.timestamp; bv = b.timestamp; }
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
              {initialLoading
                ? 'Loading drones\u2026'
                : initialIsError
                  ? 'Couldn\u2019t load drones.'
                  : `${sorted.length} drone${sorted.length === 1 ? '' : 's'} with violations in range`}
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

        {initialIsError ? (
          <div className="bg-white dark:bg-slate-800 rounded-lg border border-red-200 dark:border-red-900/40 p-10 flex flex-col items-center gap-3 text-center">
            <AlertCircle className="w-5 h-5 text-red-500" />
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {initialError?.message ?? 'Failed to load drones.'}
            </p>
            <button
              onClick={() => refetchDrones()}
              className="px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-sm bg-white dark:bg-slate-800"
            >
              Retry
            </button>
          </div>
        ) : initialLoading ? (
          <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-10 flex justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
          </div>
        ) : (
          <>
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
                  {paged.map((row) => {
                    const isOpen = expanded.has(row.droneId);
                    return (
                      <React.Fragment key={row.droneId}>
                        <tr
                          onClick={() => toggleExpand(row.droneId)}
                          className="border-b border-slate-100 dark:border-slate-700/50 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/30"
                        >
                          <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-100 font-mono" title={row.droneId}>
                            {row.droneId.slice(0, 8)}
                          </td>
                          <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{row.ownerName}</td>
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 font-mono">
                              <MapPin className="w-3 h-3" /> x:{row.x} y:{row.y} z:{row.z}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{formatRelative(row.timestamp)}</td>
                          <td className="px-4 py-3 text-slate-400">
                            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </td>
                        </tr>
                        {isOpen && (
                          <DroneHistoryRow
                            droneId={row.droneId}
                            ownerId={row.ownerId}
                            ownerName={row.ownerName}
                            colSpan={HEADERS.length + 1}
                          />
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
          </>
        )}
      </div>
    </div>
  );
}
