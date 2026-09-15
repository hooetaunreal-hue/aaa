# Resolving CORS and Securing Backend API Requests in Next.js

That **CORS error** makes sense — your browser was calling `localhost:8000` directly from client-side JavaScript, which is a different origin than your Next.js app (`localhost:3000`), and your FastAPI backend probably isn't sending the right `Access-Control-Allow-Origin` headers back.

Moving the fetch into a **Next.js Route Handler** fixes this because now the *browser* only ever talks to `localhost:3000/api/...` (same origin as the page). The actual call to `localhost:8000` happens server-to-server inside Node.js, and since CORS is purely a browser-enforced rule, it doesn't apply there at all.

> **Bonus:** It also means your `x-secret` header never ends up in client-side JavaScript where anyone could read it out of DevTools.

---

## 1. Reading Query Parameters

`NextRequest` gives you a parsed URL for free via `.nextUrl`, so you don't need to construct one yourself.

```ts
// app/api/owner_id/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const ownerId = request.nextUrl.searchParams.get('owner_id');

  if (!ownerId) {
    return NextResponse.json({ error: 'owner_id is required' }, { status: 400 });
  }

  const res = await fetch(
    `http://localhost:8000/owner_nfz?owner_id=${encodeURIComponent(ownerId)}`,
    { headers: { 'x-secret': process.env.BACKEND_SECRET! } }
  );

  if (!res.ok) {
    return NextResponse.json({ error: 'Backend request failed' }, { status: res.status });
  }

  return NextResponse.json(await res.json());
}
```

---

## 2. Refactoring with a Helper Function

Since all three of your routes (`drones`, `unique_id`, `owner_id`) need that same `x-secret` header against the same backend, it's worth pulling the fetch-with-secret logic into one small helper instead of repeating it three times:

```ts
// lib/backend.ts
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8000';

export async function fetchBackend(path: string) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    headers: { 'x-secret': process.env.BACKEND_SECRET! },
  });

  if (!res.ok) throw new Error(`Backend request failed: ${res.status}`);

  return res.json();
}
```

Which shrinks each route down to just parameter handling:

```ts
// app/api/owner_id/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { fetchBackend } from '@/lib/backend';

export async function GET(request: NextRequest) {
  const ownerId = request.nextUrl.searchParams.get('owner_id');

  if (!ownerId) {
    return NextResponse.json({ error: 'owner_id is required' }, { status: 400 });
  }

  try {
    const data = await fetchBackend(`/owner_nfz?owner_id=${encodeURIComponent(ownerId)}`);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch owner data' }, { status: 502 });
  }
}
```

---

## 3. Environment Variables Setup

Then in `.env.local` (this file should already be in `.gitignore` — worth double-checking so the secret never gets committed):

```env
BACKEND_URL=http://localhost:8000
BACKEND_SECRET=whatever-your-secret-is
```

> **Important:** Don't prefix these with `NEXT_PUBLIC_`. That prefix is a Next.js convention that means *"bundle this into the client-side JavaScript"* — the opposite of what you want for a secret. Leaving off the prefix keeps it server-only, which is exactly where your route handler runs.

---

## 4. Client-side Custom Hook

And on the frontend side, your hook just calls your *own* route, not the backend directly — this is the same `enabled` pattern from the table's expand-on-click logic, just parameterized by owner now:

```ts
// hooks/useOwnerViolations.ts
'use client';

import { useQuery } from '@tanstack/react-query';

async function fetchOwnerViolations(ownerId: string) {
  const res = await fetch(`/api/owner_id?owner_id=${encodeURIComponent(ownerId)}`);
  if (!res.ok) throw new Error('Failed to load owner violations');
  return res.json();
}

export function useOwnerViolations(ownerId: string | null) {
  return useQuery({
    queryKey: ['owner_violations', ownerId],
    queryFn: () => fetchOwnerViolations(ownerId!),
    enabled: ownerId !== null, // fires only once a row is actually expanded
  });
}
```

---

## TypeScript Note

`process.env.BACKEND_SECRET!` uses the `!` non-null assertion operator to tell TypeScript *"trust me, this exists"* — environment variables are typed as `string | undefined` by default. That's fine for a value you know is always set, but if you'd rather have it fail loudly with a clear error message when it's missing, you can swap it for a small guard at the top of `lib/backend.ts` instead.
