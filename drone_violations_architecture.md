That's the shape of it: one raw log table, then two separate query paths depending on whether you need the summary list or one drone's full history. Getting that split right on the backend is what makes the frontend simple, so let's start there.

The dedup problem basically disappears if you don't fetch raw rows for the list. With only 50 drones, you don't need a background job that maintains a "latest" table — a single GROUP BY at read time is instant even against a large table, as long as you index it:

```sql
-- Powers the main list: one row per drone, always current
SELECT 
    v.drone_id, 
    v.owner_id, 
    o.name AS owner_name,       
    MAX(v.timestamp) AS last_violation_at,       
    COUNT(*) AS violation_count
FROM violations v 
JOIN owners o ON o.id = v.owner_id
GROUP BY v.drone_id, v.owner_id, o.name
ORDER BY last_violation_at DESC;

-- Powers the expanded row: fetched only when a drone is opened
SELECT id, timestamp, lat, lng, violation_type
FROM violations 
WHERE drone_id = $1 
ORDER BY timestamp DESC 
LIMIT 100;

CREATE INDEX idx_violations_drone_ts ON violations(drone_id, timestamp DESC);
```

The `COUNT(*)` in that first query also gives you the "how many total violations" column for free, and the second query only ever runs for the one drone someone actually clicked on — never all 50 at once.

On the frontend, the honest scale check matters: you have at most 50 rows in the summary list, ever. That changes the calculus — you don't need server-side sorting, filtering, or pagination for the list itself. Fetch all 50 once, keep them in memory, and do sort/filter/paginate entirely client-side. It'll feel instant because it is. React Query (`@tanstack/react-query`) fits this well because it also gives you polling and on-demand fetching almost for free:

```typescript
const { data: violations = [] } = useQuery({  
  queryKey: ['violations', 'latest'],  
  queryFn: () => fetch('/api/violations/latest').then(r => r.json()),  
  refetchInterval: 15_000, // a bit slower than the backend's 10s cycle is fine
});

const { data: history } = useQuery({  
  queryKey: ['violations', 'history', expandedId],  
  queryFn: () => fetch(`/api/violations/history/${expandedId}`).then(r => r.json()),  
  enabled: expandedId !== null, // only fires when a row is actually expanded
});
```

Now the actual UX decisions:

*   **Expand-in-place:** what you're describing — a row's children pushing everything below it down — is just normal document flow. Render the table with real `<table>`/`<tbody>` rows for the 25 (or 50) primary rows, and when a row is expanded, conditionally render one extra `<tr>` directly after it with `colSpan` across all columns, containing the history list. No absolute positioning, no portals — it pushes the following rows down automatically because that's what block-level elements do.
*   **Sorting:** a clickable `<th>` that cycles direction on repeat clicks, with an icon (up/down/neutral chevron) showing state. Default to `lastViolation` desc. Since the list is client-side, sorting is just an array `.sort()` — no round trip.
*   **Time-range filter:** a slider bound to 1–72 (hours), filtering `now - lastViolationTimestamp <= rangeHours`. Since it only touches the in-memory list, it's instant too — no debounce needed.
*   **Pagination:** is 2 pages of 25 right? Honestly, at ≤50 rows this is a density preference, not a performance necessity. Either works fine: pagination avoids an inner scrollbar in a fixed-height dashboard quadrant, while a single scrollable list feels less clicky. If the bottom half of your dashboard has generous vertical space, skip pagination entirely and just scroll; if it's cramped, paginate. I wouldn't lose sleep over it either way.

One library worth knowing about: TanStack Table (`@tanstack/react-table`) has a built-in "expanding rows" model that matches this exact parent/sub-row pattern, plus sorting and pagination out of the box. Worth adopting once the table grows more columns — the demo below hand-rolls the logic so you can see exactly what's happening underneath first.

For the other three basics, quickly:

*   **Lazy loading:** wrap the map and analytics quadrants in `next/dynamic(() => import('./DroneMap'), { ssr: false, loading: () => <Skeleton/> })`. Map libraries (Leaflet/MapLibre) are heavy and need `window`, so this keeps them out of your initial bundle and shows a skeleton while the chunk loads.
*   **i18n without routing:** skip `next-intl`/`next-i18next`'s routing entirely and roll a small `LocaleContext`: a locale state (seeded from `localStorage`/`navigator.language`), per-locale JSON dictionaries, and a `t(key)` lookup. Switching language just calls `setLocale('fi')` — a context update, zero navigation, URL untouched.
*   **Theme system:** CSS variables in `globals.css` (`--color-bg`, `--color-fg`, etc.) referenced from `tailwind.config`, toggled via a `dark` class on `<html>` (`darkMode: 'class'`). Use `next-themes` to get no-flash-on-load and `localStorage` persistence for free instead of hand-rolling it.

Now let's look at the table itself.

A few notes on adapting this into your actual app:

1. Add `'use client'` at the top of the file — it uses hooks, so it needs to be a Client Component under the App Router.
2. Swap `makeMockData()` for your `useQuery` call and drop history fetching into the expand handler as shown earlier.
3. The expand/collapse here is instant since this sandbox doesn't run Tailwind's full compiler. In your real app, arbitrary values work, so you can get a genuinely smooth slide-down by wrapping the history content in a div that animates `grid-template-rows` between `0fr` and `1fr` (with `overflow-hidden` on the inner wrapper) — it's the one CSS-only technique that animates to "auto" height correctly, and it holds up much better than trying to animate `max-height`.
4. If you want multiple rows expanded at once vs. one at a time, that's the `expanded` Set — swap it for a single `expandedId` state if you'd rather only one drone be open at a time.
