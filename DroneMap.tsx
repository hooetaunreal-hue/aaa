"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

export interface Drone {
  drone_id: string;
  owner_id: number;
  x: number;
  y: number;
  z: number;
}

export interface WorldBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface DroneMapProps {
  className?: string;
  /** Defaults to `/api/drones/`. */
  endpoint?: string;
  /** Polling cadence in ms. Defaults to 1000. */
  pollIntervalMs?: number;
  /**
   * Optional minimum world extent. The map always grows to include every drone
   * it has ever received, so this is only needed to pre-size the viewport.
   */
  worldBounds?: WorldBounds;
}

/* -------------------------------------------------------------------------- */
/*  Internal types                                                            */
/* -------------------------------------------------------------------------- */

interface Camera {
  /** World-space point at the centre of the viewport. */
  x: number;
  y: number;
  /** Screen pixels per world unit. */
  zoom: number;
}

interface Viewport {
  width: number;
  height: number;
  dpr: number;
}

interface DisplayDrone {
  id: string;
  ownerId: number;
  color: string;
  /** Currently drawn (eased) position. */
  x: number;
  y: number;
  /** Latest position reported by the API. */
  tx: number;
  ty: number;
}

interface DroneSnapshot {
  drones: Drone[];
  latencyMs: number;
}

interface DragState {
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
}

interface PinchState {
  startDistance: number;
  startZoom: number;
  anchorX: number;
  anchorY: number;
}

type InflightRef = { current: number | null };
type StaleReason = "error" | "slow" | "overdue";
type FeedHealth =
  | { status: "live" }
  | {
      status: "stale";
      reason: StaleReason;
      inflightMs: number;
      sinceUpdateMs: number | null;
      latencyMs: number | null;
    };
type StaleHealth = Extract<FeedHealth, { status: "stale" }>;

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const DEFAULT_ENDPOINT = "/api/drones/";
const DEFAULT_POLL_INTERVAL_MS = 1000;
const LATENCY_THRESHOLD_MS = 1500;
const REQUEST_TIMEOUT_MS = 8000;
const HEALTH_TICK_MS = 250;

const FALLBACK_BOUNDS: WorldBounds = { minX: -50, maxX: 50, minY: -50, maxY: 50 };
const MIN_WORLD_SPAN = 20;
const MIN_WORLD_PAD = 5;
const FIT_MARGIN = 0.9;
const MIN_ZOOM_FACTOR = 0.75;
const MAX_ZOOM_FACTOR = 60;

const DOT_RADIUS = 5.5;
const HIT_RADIUS_MOUSE = 12;
const HIT_RADIUS_TOUCH = 22;
const CLICK_SLOP_PX = 5;
const VIEW_MARGIN_PX = 32;

const POSITION_SMOOTHING_MS = 220;
const CAMERA_SMOOTHING_MS = 110;

const MIN_GRID_PX = 44;
const GRID_MAJOR_EVERY = 5;
const TAU = Math.PI * 2;

const EMPTY_DRONES: readonly Drone[] = [];
const LIVE: FeedHealth = { status: "live" };

const GRID_STYLE: CSSProperties = {
  backgroundImage: [
    "linear-gradient(to right, rgba(15,23,42,0.085) 1px, transparent 1px)",
    "linear-gradient(to bottom, rgba(15,23,42,0.085) 1px, transparent 1px)",
    "linear-gradient(to right, rgba(15,23,42,0.04) 1px, transparent 1px)",
    "linear-gradient(to bottom, rgba(15,23,42,0.04) 1px, transparent 1px)",
  ].join(", "),
  backgroundSize: "64px 64px",
};

const BANNER_STYLES: Record<StaleReason, { box: string; dot: string; sub: string }> = {
  error: {
    box: "border-red-300 bg-red-50/95 text-red-950 shadow-red-900/10",
    dot: "bg-red-500",
    sub: "text-red-900/70",
  },
  slow: {
    box: "border-amber-300 bg-amber-50/95 text-amber-950 shadow-amber-900/10",
    dot: "bg-amber-500",
    sub: "text-amber-900/70",
  },
  overdue: {
    box: "border-amber-300 bg-amber-50/95 text-amber-950 shadow-amber-900/10",
    dot: "bg-amber-500",
    sub: "text-amber-900/70",
  },
};

/* -------------------------------------------------------------------------- */
/*  Pure helpers                                                              */
/* -------------------------------------------------------------------------- */

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const mod = (n: number, m: number) => ((n % m) + m) % m;
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function ownerColor(ownerId: number): string {
  const hue = (Math.abs(ownerId) * 137.508) % 360;
  return `hsl(${hue.toFixed(1)}, 72%, 46%)`;
}

function formatCoordinate(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "n/a";
}

function isDrone(value: unknown): value is Drone {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.drone_id === "string" &&
    isFiniteNumber(v.owner_id) &&
    isFiniteNumber(v.x) &&
    isFiniteNumber(v.y) &&
    isFiniteNumber(v.z)
  );
}

function parseDrones(json: unknown): Drone[] {
  if (!Array.isArray(json)) throw new Error("Unexpected drone feed payload");
  return json.filter(isDrone);
}

function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function localPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const r = canvas.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}

/* ---- world bounds -------------------------------------------------------- */

function bboxOf(drones: readonly Drone[]): WorldBounds | null {
  if (drones.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < drones.length; i++) {
    const d = drones[i];
    if (d.x < minX) minX = d.x;
    if (d.x > maxX) maxX = d.x;
    if (d.y < minY) minY = d.y;
    if (d.y > maxY) maxY = d.y;
  }
  return { minX, maxX, minY, maxY };
}

function containsBounds(outer: WorldBounds, inner: WorldBounds): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  );
}

function unionBounds(a: WorldBounds, b: WorldBounds): WorldBounds {
  return {
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function padBounds(b: WorldBounds): WorldBounds {
  const padX = Math.max((b.maxX - b.minX) * 0.15, MIN_WORLD_PAD);
  const padY = Math.max((b.maxY - b.minY) * 0.15, MIN_WORLD_PAD);
  return { minX: b.minX - padX, maxX: b.maxX + padX, minY: b.minY - padY, maxY: b.maxY + padY };
}

function ensureMinSpan(b: WorldBounds): WorldBounds {
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  if (w >= MIN_WORLD_SPAN && h >= MIN_WORLD_SPAN) return b;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const hw = Math.max(w, MIN_WORLD_SPAN) / 2;
  const hh = Math.max(h, MIN_WORLD_SPAN) / 2;
  return { minX: cx - hw, maxX: cx + hw, minY: cy - hh, maxY: cy + hh };
}

/** Grow-only bounds: expands to include new drones but never shrinks. */
function nextBounds(
  prev: WorldBounds | null,
  base: WorldBounds | undefined,
  drones: readonly Drone[],
): WorldBounds {
  const box = bboxOf(drones);
  const seed = prev ?? base ?? null;
  if (!box) return ensureMinSpan(seed ?? FALLBACK_BOUNDS);
  if (seed && containsBounds(seed, box)) return ensureMinSpan(seed);
  const padded = padBounds(box);
  return ensureMinSpan(seed ? unionBounds(seed, padded) : padded);
}

/* ---- camera -------------------------------------------------------------- */

function fitZoomFor(bounds: WorldBounds, vw: number, vh: number): number {
  const w = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const h = Math.max(bounds.maxY - bounds.minY, 1e-6);
  return Math.min(vw / w, vh / h) * FIT_MARGIN;
}

function zoomLimits(bounds: WorldBounds, vw: number, vh: number) {
  const fit = fitZoomFor(bounds, vw, vh);
  return { min: fit * MIN_ZOOM_FACTOR, max: fit * MAX_ZOOM_FACTOR };
}

function constrainCamera(cam: Camera, bounds: WorldBounds, vw: number, vh: number): void {
  if (vw <= 0 || vh <= 0) return;
  const { min, max } = zoomLimits(bounds, vw, vh);
  cam.zoom = clamp(cam.zoom, min, max);
  cam.x = clamp(cam.x, bounds.minX, bounds.maxX);
  cam.y = clamp(cam.y, bounds.minY, bounds.maxY);
}

/* ---- canvas drawing ------------------------------------------------------ */

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  state: "idle" | "hover" | "selected",
  following: boolean,
) {
  if (state === "selected") {
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, TAU);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.13;
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(x, y, 12.5, 0, TAU);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(following ? [] : [3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (state === "hover") {
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, TAU);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.4;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.save();
  ctx.shadowColor = "rgba(15, 23, 42, 0.28)";
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 1;
  ctx.beginPath();
  ctx.arc(x, y, state === "selected" ? DOT_RADIUS + 1.5 : DOT_RADIUS, 0, TAU);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(x, y, state === "selected" ? DOT_RADIUS + 1.5 : DOT_RADIUS, 0, TAU);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  viewWidth: number,
) {
  ctx.font = "600 11px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
  const w = ctx.measureText(text).width + 14;
  const h = 22;
  const above = y - 34 >= 4;
  const lx = clamp(x - w / 2, 4, Math.max(4, viewWidth - w - 4));
  const ly = above ? y - 34 : y + 14;
  roundedRectPath(ctx, lx, ly, w, h, 8);
  ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, lx + w / 2, ly + h / 2 + 0.5);
}

/* -------------------------------------------------------------------------- */
/*  Data layer                                                                */
/* -------------------------------------------------------------------------- */

async function fetchDrones(
  endpoint: string,
  signal: AbortSignal | undefined,
  inflightSince: InflightRef,
): Promise<DroneSnapshot> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const startedAt = performance.now();
  inflightSince.current = Date.now();
  try {
    const res = await fetch(endpoint, {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Drone feed responded with status ${res.status}`);
    const json: unknown = await res.json();
    return {
      drones: parseDrones(json),
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
    inflightSince.current = null;
  }
}

interface HealthInput {
  dataUpdatedAt: number;
  isError: boolean;
  latencyMs: number | null;
  staleAfterMs: number;
}

function evaluateHealth(input: HealthInput, inflightSince: number | null, now: number): FeedHealth {
  const quantize = (ms: number) => Math.round(ms / 100) * 100;
  const inflightMs = inflightSince === null ? 0 : Math.max(0, now - inflightSince);
  const sinceUpdateMs = input.dataUpdatedAt > 0 ? Math.max(0, now - input.dataUpdatedAt) : null;

  let reason: StaleReason | null = null;
  if (input.isError) reason = "error";
  else if (inflightMs > LATENCY_THRESHOLD_MS || (input.latencyMs ?? 0) > LATENCY_THRESHOLD_MS)
    reason = "slow";
  else if (sinceUpdateMs !== null && sinceUpdateMs > input.staleAfterMs) reason = "overdue";

  if (!reason) return LIVE;
  return {
    status: "stale",
    reason,
    inflightMs: quantize(inflightMs),
    sinceUpdateMs: sinceUpdateMs === null ? null : quantize(sinceUpdateMs),
    latencyMs: input.latencyMs,
  };
}

function sameHealth(a: FeedHealth, b: FeedHealth): boolean {
  if (a.status === "live" || b.status === "live") return a.status === b.status;
  return (
    a.reason === b.reason &&
    a.inflightMs === b.inflightMs &&
    a.sinceUpdateMs === b.sinceUpdateMs &&
    a.latencyMs === b.latencyMs
  );
}

/**
 * Re-evaluates feed health on a timer but only triggers a render when the
 * derived value actually changes, so a healthy feed never re-renders on ticks.
 */
function useFeedHealth(input: HealthInput, inflightSince: InflightRef): FeedHealth {
  const { dataUpdatedAt, isError, latencyMs, staleAfterMs } = input;
  const [health, setHealth] = useState<FeedHealth>(LIVE);

  useEffect(() => {
    const evaluate = () => {
      const next = evaluateHealth(
        { dataUpdatedAt, isError, latencyMs, staleAfterMs },
        inflightSince.current,
        Date.now(),
      );
      setHealth((prev) => (sameHealth(prev, next) ? prev : next));
    };
    evaluate();
    const id = window.setInterval(evaluate, HEALTH_TICK_MS);
    return () => window.clearInterval(id);
  }, [dataUpdatedAt, isError, latencyMs, staleAfterMs, inflightSince]);

  return health;
}

function useDroneFeed(endpoint: string, pollIntervalMs: number) {
  const inflightSince = useRef<number | null>(null);

  const query = useQuery<DroneSnapshot, Error>({
    queryKey: ["drones", endpoint],
    queryFn: ({ signal }) => fetchDrones(endpoint, signal, inflightSince),
    refetchInterval: pollIntervalMs,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: 0,
  });

  const drones: readonly Drone[] = query.data?.drones ?? EMPTY_DRONES;
  const latencyMs = query.data?.latencyMs ?? null;

  const health = useFeedHealth(
    {
      dataUpdatedAt: query.dataUpdatedAt,
      isError: query.isError,
      latencyMs,
      staleAfterMs: pollIntervalMs + LATENCY_THRESHOLD_MS,
    },
    inflightSince,
  );

  return { drones, latencyMs, hasData: query.data !== undefined, health };
}

function useWorldBounds(base: WorldBounds | undefined, drones: readonly Drone[]): WorldBounds {
  const ref = useRef<WorldBounds | null>(null);
  return useMemo(() => {
    const next = nextBounds(ref.current, base, drones);
    ref.current = next;
    return next;
  }, [base, drones]);
}

/* -------------------------------------------------------------------------- */
/*  Presentational pieces                                                     */
/* -------------------------------------------------------------------------- */

interface IconProps {
  className?: string;
}

function IconReset({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function IconClose({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function IconLock({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function IconCrosshair({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="22" x2="18" y1="12" y2="12" />
      <line x1="6" x2="2" y1="12" y2="12" />
      <line x1="12" x2="12" y1="6" y2="2" />
      <line x1="12" x2="12" y1="22" y2="18" />
    </svg>
  );
}

function describeStale(h: StaleHealth): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  switch (h.reason) {
    case "error":
      return h.sinceUpdateMs !== null
        ? `Feed unreachable. Last update was ${s(h.sinceUpdateMs)} ago.`
        : "Feed unreachable. No data received yet.";
    case "slow":
      return h.inflightMs > LATENCY_THRESHOLD_MS
        ? `Request pending for ${s(h.inflightMs)}. Positions may be outdated.`
        : `Last response took ${s(h.latencyMs ?? 0)}. Positions may be outdated.`;
    case "overdue":
      return `No update for ${s(h.sinceUpdateMs ?? 0)}. Positions may be outdated.`;
  }
}

function StaleBanner({ health }: { health: StaleHealth }) {
  const styles = BANNER_STYLES[health.reason];
  return (
    <div
      role="alert"
      className="pointer-events-none absolute inset-x-16 top-4 z-30 flex justify-center"
    >
      <div
        className={`flex max-w-full items-center gap-3 rounded-2xl border px-4 py-2.5 shadow-lg backdrop-blur-md ${styles.box}`}
      >
        <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
          <span
            className={`absolute inline-flex h-full w-full rounded-full opacity-70 motion-safe:animate-ping ${styles.dot}`}
          />
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${styles.dot}`} />
        </span>
        <div className="min-w-0 leading-snug">
          <p className="truncate text-sm font-semibold">Data Stale / High Latency</p>
          <p className={`truncate text-xs ${styles.sub}`}>{describeStale(health)}</p>
        </div>
      </div>
    </div>
  );
}

interface StatusChipProps {
  health: FeedHealth;
  hasData: boolean;
  latencyMs: number | null;
  droneCount: number;
}

function StatusChip({ health, hasData, latencyMs, droneCount }: StatusChipProps) {
  const stale = health.status === "stale";
  const label = stale ? "Stale" : hasData ? "Live" : "Connecting";
  const dot = stale ? "bg-amber-500" : hasData ? "bg-emerald-500" : "bg-slate-400";
  return (
    <div className="pointer-events-none flex shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm backdrop-blur-md">
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
      <span>{label}</span>
      {latencyMs !== null && <span className="tabular-nums text-slate-400">{latencyMs} ms</span>}
      <span className="hidden tabular-nums text-slate-400 sm:inline">
        {droneCount} {droneCount === 1 ? "drone" : "drones"}
      </span>
    </div>
  );
}

interface DroneCardProps {
  drone: Drone;
  following: boolean;
  onFollow: () => void;
  onClose: () => void;
}

function DroneCard({ drone, following, onFollow, onClose }: DroneCardProps) {
  const color = ownerColor(drone.owner_id);
  const axes = [
    { key: "x", value: drone.x },
    { key: "y", value: drone.y },
    { key: "z", value: drone.z },
  ] as const;

  return (
    <section
      aria-label={`Selected drone ${drone.drone_id}`}
      className="pointer-events-auto w-full max-w-sm rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-xl shadow-slate-900/10 backdrop-blur-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex h-3 w-3 shrink-0" aria-hidden="true">
            <span className="absolute -inset-1 rounded-full opacity-25" style={{ backgroundColor: color }} />
            <span className="relative h-3 w-3 rounded-full ring-2 ring-white" style={{ backgroundColor: color }} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tabular-nums text-slate-900" title={drone.drone_id}>
              {drone.drone_id}
            </p>
            <p className="text-xs text-slate-500">
              Owner <span className="font-medium tabular-nums text-slate-700">{drone.owner_id}</span>
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Deselect drone"
          className="-m-1 rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>

      <p className="mt-3 text-xs text-slate-500">Position (x, y, z)</p>
      <dl className="mt-1.5 grid grid-cols-3 gap-2">
        {axes.map(({ key, value }) => (
          <div key={key} className="rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-inset ring-slate-200/70">
            <dt className="text-xs font-medium text-slate-400">{key}</dt>
            <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums text-slate-900">
              {formatCoordinate(value)}
            </dd>
          </div>
        ))}
      </dl>

      {following ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-700">
          <IconLock className="h-3.5 w-3.5" />
          Camera is following this drone
        </p>
      ) : (
        <button
          type="button"
          onClick={onFollow}
          className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
        >
          <IconCrosshair className="h-3.5 w-3.5" />
          Follow drone
        </button>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Map                                                                       */
/* -------------------------------------------------------------------------- */

export function DroneMap({
  className,
  endpoint = DEFAULT_ENDPOINT,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  worldBounds,
}: DroneMapProps) {
  const { drones, latencyMs, hasData, health } = useDroneFeed(endpoint, pollIntervalMs);
  const bounds = useWorldBounds(worldBounds, drones);

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const viewportRef = useRef<Viewport>({ width: 0, height: 0, dpr: 1 });
  const boundsRef = useRef<WorldBounds>(bounds);
  const displayMapRef = useRef<Map<string, DisplayDrone>>(new Map());
  const displayListRef = useRef<DisplayDrone[]>([]);

  const selectedIdRef = useRef<string | null>(null);
  const followingRef = useRef(false);
  const hoverIdRef = useRef<string | null>(null);
  const autoFitRef = useRef(true);

  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const dragRef = useRef<DragState | null>(null);
  const pinchRef = useRef<PinchState | null>(null);

  const rafRef = useRef(0);
  const lastFrameRef = useRef(0);
  const stepRef = useRef<FrameRequestCallback | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);

  /* ---- render scheduling ------------------------------------------------- */

  const requestRender = useCallback(() => {
    const step = stepRef.current;
    if (rafRef.current || !step) return;
    lastFrameRef.current = performance.now();
    rafRef.current = requestAnimationFrame(step);
  }, []);

  /* ---- camera / selection actions --------------------------------------- */

  const fitCamera = useCallback(() => {
    const { width, height } = viewportRef.current;
    if (width <= 0 || height <= 0) return;
    const b = boundsRef.current;
    const cam = cameraRef.current;
    cam.x = (b.minX + b.maxX) / 2;
    cam.y = (b.minY + b.maxY) / 2;
    cam.zoom = fitZoomFor(b, width, height);
  }, []);

  const markManualCamera = useCallback(() => {
    autoFitRef.current = false;
    if (followingRef.current) {
      followingRef.current = false;
      setIsFollowing(false);
    }
  }, []);

  const setSelection = useCallback(
    (id: string | null, follow: boolean) => {
      const shouldFollow = id !== null && follow;
      selectedIdRef.current = id;
      followingRef.current = shouldFollow;
      if (shouldFollow) autoFitRef.current = false;
      setSelectedId(id);
      setIsFollowing(shouldFollow);
      requestRender();
    },
    [requestRender],
  );

  const resetView = useCallback(() => {
    if (followingRef.current) {
      followingRef.current = false;
      setIsFollowing(false);
    }
    autoFitRef.current = true;
    fitCamera();
    requestRender();
  }, [fitCamera, requestRender]);

  const zoomAt = useCallback(
    (nextZoom: number, sx: number, sy: number) => {
      const cam = cameraRef.current;
      const { width, height } = viewportRef.current;
      if (width <= 0 || height <= 0) return;
      const limits = zoomLimits(boundsRef.current, width, height);
      const zoom = clamp(nextZoom, limits.min, limits.max);
      if (Math.abs(zoom - cam.zoom) <= cam.zoom * 1e-6) return;
      const wx = cam.x + (sx - width / 2) / cam.zoom;
      const wy = cam.y - (sy - height / 2) / cam.zoom;
      cam.zoom = zoom;
      cam.x = wx - (sx - width / 2) / zoom;
      cam.y = wy + (sy - height / 2) / zoom;
      markManualCamera();
      requestRender();
    },
    [markManualCamera, requestRender],
  );

  const panBy = useCallback(
    (dxPx: number, dyPx: number) => {
      const cam = cameraRef.current;
      cam.x -= dxPx / cam.zoom;
      cam.y += dyPx / cam.zoom;
      markManualCamera();
      requestRender();
    },
    [markManualCamera, requestRender],
  );

  const pickDrone = useCallback((sx: number, sy: number, radius: number): string | null => {
    const { width, height } = viewportRef.current;
    const cam = cameraRef.current;
    const list = displayListRef.current;
    let best: string | null = null;
    let bestDist = radius * radius;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      const px = width / 2 + (d.x - cam.x) * cam.zoom;
      const py = height / 2 - (d.y - cam.y) * cam.zoom;
      const dist = (px - sx) * (px - sx) + (py - sy) * (py - sy);
      if (dist <= bestDist) {
        bestDist = dist;
        best = d.id;
      }
    }
    return best;
  }, []);

  /* ---- render loop (imperative, on demand) ------------------------------- */

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      const { width, height, dpr } = viewportRef.current;
      if (!canvas || width <= 0 || height <= 0) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const cam = cameraRef.current;
      const z = cam.zoom;
      const cx = width / 2;
      const cy = height / 2;

      const grid = gridRef.current;
      if (grid) {
        const minor = niceStep(MIN_GRID_PX / z) * z;
        const major = minor * GRID_MAJOR_EVERY;
        const ox = cx - cam.x * z;
        const oy = cy + cam.y * z;
        const major0 = `${mod(ox, major)}px ${mod(oy, major)}px`;
        const minor0 = `${mod(ox, minor)}px ${mod(oy, minor)}px`;
        grid.style.backgroundSize = `${major}px ${major}px, ${major}px ${major}px, ${minor}px ${minor}px, ${minor}px ${minor}px`;
        grid.style.backgroundPosition = `${major0}, ${major0}, ${minor0}, ${minor0}`;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const selectedId = selectedIdRef.current;
      const hoverId = hoverIdRef.current;
      const following = followingRef.current;
      const list = displayListRef.current;

      let selected: { d: DisplayDrone; sx: number; sy: number } | null = null;
      let hovered: { d: DisplayDrone; sx: number; sy: number } | null = null;

      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        const sx = cx + (d.x - cam.x) * z;
        const sy = cy - (d.y - cam.y) * z;
        if (
          sx < -VIEW_MARGIN_PX ||
          sx > width + VIEW_MARGIN_PX ||
          sy < -VIEW_MARGIN_PX ||
          sy > height + VIEW_MARGIN_PX
        ) {
          continue;
        }
        if (d.id === selectedId) {
          selected = { d, sx, sy };
        } else if (d.id === hoverId) {
          hovered = { d, sx, sy };
        } else {
          drawDot(ctx, sx, sy, d.color, "idle", false);
        }
      }

      if (hovered) {
        drawDot(ctx, hovered.sx, hovered.sy, hovered.d.color, "hover", false);
        drawLabel(ctx, hovered.d.id, hovered.sx, hovered.sy, width);
      }
      if (selected) {
        drawDot(ctx, selected.sx, selected.sy, selected.d.color, "selected", following);
        drawLabel(ctx, selected.d.id, selected.sx, selected.sy, width);
      }
    };

    const step: FrameRequestCallback = (now) => {
      rafRef.current = 0;
      const dt = Math.min(64, Math.max(0, now - lastFrameRef.current));
      lastFrameRef.current = now;

      const { width, height } = viewportRef.current;
      const cam = cameraRef.current;
      const epsilon = 0.05 / Math.max(cam.zoom, 1e-9);
      let animating = false;

      const positionK = 1 - Math.exp(-dt / POSITION_SMOOTHING_MS);
      const list = displayListRef.current;
      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        const dx = d.tx - d.x;
        const dy = d.ty - d.y;
        if (dx === 0 && dy === 0) continue;
        if (Math.abs(dx) <= epsilon && Math.abs(dy) <= epsilon) {
          d.x = d.tx;
          d.y = d.ty;
        } else {
          d.x += dx * positionK;
          d.y += dy * positionK;
          animating = true;
        }
      }

      const followId = followingRef.current ? selectedIdRef.current : null;
      const target = followId ? displayMapRef.current.get(followId) : undefined;
      if (target) {
        const dx = target.x - cam.x;
        const dy = target.y - cam.y;
        if (Math.abs(dx) <= epsilon && Math.abs(dy) <= epsilon) {
          cam.x = target.x;
          cam.y = target.y;
        } else {
          const cameraK = 1 - Math.exp(-dt / CAMERA_SMOOTHING_MS);
          cam.x += dx * cameraK;
          cam.y += dy * cameraK;
          animating = true;
        }
      }

      constrainCamera(cam, boundsRef.current, width, height);
      draw();

      if (animating) rafRef.current = requestAnimationFrame(step);
    };

    stepRef.current = step;
    lastFrameRef.current = performance.now();
    rafRef.current = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      stepRef.current = null;
    };
  }, []);

  /* ---- viewport sizing --------------------------------------------------- */

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;

    const resize = () => {
      const width = root.clientWidth;
      const height = root.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      viewportRef.current = { width, height, dpr };
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      if (autoFitRef.current) fitCamera();
      requestRender();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    return () => observer.disconnect();
  }, [fitCamera, requestRender]);

  /* ---- wheel zoom (needs a non-passive native listener) ------------------ */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewportRef.current.height : 1;
      const delta = clamp(e.deltaY * unit, -400, 400);
      const factor = Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015));
      const p = localPoint(canvas, e.clientX, e.clientY);
      zoomAt(cameraRef.current.zoom * factor, p.x, p.y);
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  /* ---- world bounds sync ------------------------------------------------- */

  useEffect(() => {
    boundsRef.current = bounds;
    if (autoFitRef.current) fitCamera();
    requestRender();
  }, [bounds, fitCamera, requestRender]);

  /* ---- data sync: API positions become easing targets -------------------- */

  useEffect(() => {
    const map = displayMapRef.current;
    const seen = new Set<string>();

    for (let i = 0; i < drones.length; i++) {
      const d = drones[i];
      seen.add(d.drone_id);
      const existing = map.get(d.drone_id);
      if (existing) {
        existing.tx = d.x;
        existing.ty = d.y;
        if (existing.ownerId !== d.owner_id) {
          existing.ownerId = d.owner_id;
          existing.color = ownerColor(d.owner_id);
        }
      } else {
        map.set(d.drone_id, {
          id: d.drone_id,
          ownerId: d.owner_id,
          color: ownerColor(d.owner_id),
          x: d.x,
          y: d.y,
          tx: d.x,
          ty: d.y,
        });
      }
    }

    map.forEach((_, id) => {
      if (!seen.has(id)) map.delete(id);
    });
    displayListRef.current = Array.from(map.values());
    requestRender();
  }, [drones, requestRender]);

  /* ---- drop selection if the drone leaves the feed ----------------------- */

  useEffect(() => {
    if (selectedId !== null && !drones.some((d) => d.drone_id === selectedId)) {
      setSelection(null, false);
    }
  }, [drones, selectedId, setSelection]);

  /* ---- pointer handling: drag to pan, pinch to zoom, tap to select ------- */

  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const canvas = e.currentTarget;
    canvas.setPointerCapture(e.pointerId);

    const pointers = pointersRef.current;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      dragRef.current = {
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
      };
    } else if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      if (a && b) {
        const mid = localPoint(canvas, (a.x + b.x) / 2, (a.y + b.y) / 2);
        const { width, height } = viewportRef.current;
        const cam = cameraRef.current;
        pinchRef.current = {
          startDistance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          startZoom: cam.zoom,
          anchorX: cam.x + (mid.x - width / 2) / cam.zoom,
          anchorY: cam.y - (mid.y - height / 2) / cam.zoom,
        };
        if (dragRef.current) dragRef.current.moved = true;
      }
    }
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const pointers = pointersRef.current;
    const tracked = pointers.get(e.pointerId);
    if (tracked) {
      tracked.x = e.clientX;
      tracked.y = e.clientY;
    }

    const pinch = pinchRef.current;
    if (pinch && pointers.size >= 2) {
      const [a, b] = Array.from(pointers.values());
      if (!a || !b) return;
      const { width, height } = viewportRef.current;
      const mid = localPoint(canvas, (a.x + b.x) / 2, (a.y + b.y) / 2);
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const limits = zoomLimits(boundsRef.current, width, height);
      const zoom = clamp((pinch.startZoom * distance) / pinch.startDistance, limits.min, limits.max);
      const cam = cameraRef.current;
      cam.zoom = zoom;
      cam.x = pinch.anchorX - (mid.x - width / 2) / zoom;
      cam.y = pinch.anchorY + (mid.y - height / 2) / zoom;
      markManualCamera();
      requestRender();
      return;
    }

    const drag = dragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < CLICK_SLOP_PX) return;
        drag.moved = true;
        canvas.style.cursor = "grabbing";
      }
      panBy(e.clientX - drag.lastX, e.clientY - drag.lastY);
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      return;
    }

    if (e.pointerType !== "touch" && pointers.size === 0) {
      const p = localPoint(canvas, e.clientX, e.clientY);
      const id = pickDrone(p.x, p.y, HIT_RADIUS_MOUSE);
      if (id !== hoverIdRef.current) {
        hoverIdRef.current = id;
        canvas.style.cursor = id ? "pointer" : "";
        requestRender();
      }
    }
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const pointers = pointersRef.current;
    if (!pointers.delete(e.pointerId)) return;
    canvas.style.cursor = "";

    if (pinchRef.current) {
      if (pointers.size < 2) {
        pinchRef.current = null;
        const rest = Array.from(pointers.entries())[0];
        dragRef.current = rest
          ? {
              pointerId: rest[0],
              pointerType: "touch",
              startX: rest[1].x,
              startY: rest[1].y,
              lastX: rest[1].x,
              lastY: rest[1].y,
              moved: true,
            }
          : null;
      }
      return;
    }

    const drag = dragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      dragRef.current = null;
      if (!drag.moved && e.type === "pointerup") {
        const p = localPoint(canvas, e.clientX, e.clientY);
        const radius = drag.pointerType === "mouse" ? HIT_RADIUS_MOUSE : HIT_RADIUS_TOUCH;
        const hit = pickDrone(p.x, p.y, radius);
        if (hit) setSelection(hit, true);
        else if (selectedIdRef.current !== null) setSelection(null, false);
      }
    }
  };

  const handlePointerLeave = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (hoverIdRef.current !== null) {
      hoverIdRef.current = null;
      e.currentTarget.style.cursor = "";
      requestRender();
    }
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const { width, height } = viewportRef.current;
    const zoom = cameraRef.current.zoom;
    const step = 72;
    switch (e.key) {
      case "Escape":
        setSelection(null, false);
        break;
      case "+":
      case "=":
        zoomAt(zoom * 1.25, width / 2, height / 2);
        break;
      case "-":
      case "_":
        zoomAt(zoom / 1.25, width / 2, height / 2);
        break;
      case "0":
        resetView();
        break;
      case "ArrowLeft":
        panBy(step, 0);
        break;
      case "ArrowRight":
        panBy(-step, 0);
        break;
      case "ArrowUp":
        panBy(0, step);
        break;
      case "ArrowDown":
        panBy(0, -step);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  /* ---- derived UI state -------------------------------------------------- */

  const selectedDrone = useMemo(
    () => (selectedId === null ? null : (drones.find((d) => d.drone_id === selectedId) ?? null)),
    [drones, selectedId],
  );

  const rootClassName = [
    "relative isolate h-full min-h-0 w-full min-w-0 flex-1 self-stretch overflow-hidden",
    "rounded-3xl border border-slate-200 bg-white shadow-sm",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={rootRef} className={rootClassName}>
      <div ref={gridRef} aria-hidden="true" className="pointer-events-none absolute inset-0" style={GRID_STYLE} />

      <canvas
        ref={canvasRef}
        role="application"
        aria-label={`Interactive drone map showing ${drones.length} ${drones.length === 1 ? "drone" : "drones"}. Drag to pan, scroll or pinch to zoom, arrow keys to move, plus and minus to zoom, zero to reset.`}
        tabIndex={0}
        className="absolute inset-0 block h-full w-full cursor-grab touch-none select-none rounded-3xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400/70"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onKeyDown={handleKeyDown}
      />

      {health.status === "stale" && <StaleBanner health={health} />}

      <button
        type="button"
        onClick={resetView}
        aria-label="Reset view"
        className="absolute right-4 top-4 z-40 inline-flex h-10 items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 text-sm font-medium text-slate-700 shadow-md shadow-slate-900/5 backdrop-blur-md transition hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 active:scale-95"
      >
        <IconReset className="h-4 w-4" />
        <span className="hidden sm:inline">Reset view</span>
      </button>

      <div className="pointer-events-none absolute inset-x-4 bottom-4 z-20 flex items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          {selectedDrone && (
            <DroneCard
              drone={selectedDrone}
              following={isFollowing}
              onFollow={() => setSelection(selectedDrone.drone_id, true)}
              onClose={() => setSelection(null, false)}
            />
          )}
        </div>
        <StatusChip health={health} hasData={hasData} latencyMs={latencyMs} droneCount={drones.length} />
      </div>
    </div>
  );
}

export default DroneMap;
