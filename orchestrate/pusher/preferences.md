# Standing orders: pusher program

S1. Target Pusher Channels protocol v7 only. Reject protocol >7 or <7 with 4007 and a missing protocol with 4008. No v1-6, XHR, flash, or fallback transports.

S2. Reuse the existing Workers scaffold: Vite + Hono + Valibot + Durable Objects + Vitest in workerd. No frontend, no accounts, no teams, no quotas, no billing. Delete the depush deployment domain, D1, and Drizzle.

S3. One app from env PUSHER_APP_ID, PUSHER_APP_KEY, PUSHER_APP_SECRET. One AppHub Durable Object per app is the single writer for sockets and channel membership.

S4. Drop-in means official pusher-js 8.x and the official pusher Node server SDK work unmodified, including HTTP signatures, body_md5, socket_id exclusion, and protocol frames. Protocol units run scripts/compat.mjs.

S5. A unit is done only when pnpm check, pnpm typecheck, pnpm test, pnpm build, and the compat harness pass. Put the command output in the report.

S6. One worker at a time on branch unit/<id>. Never rebase or force-push. The coordinator reviews and lands on local main. There is no remote and no PR.

S7. TypeScript strict: no any, casts, ts-ignore, or non-null assertions. Valibot parses every inbound frame and HTTP body. No narration comments.

S8. v1 excludes webhooks, cache channels, Live Activities, Beams, user signin/watchlists, and encrypted channels. Encrypted channels get a 4009 error; no key derivation, no shared-secret provisioning.

S9. Stay inside the unit brief. Park anything else as a follow-up in the report; do not widen the diff.

S10. Secrets never get committed. .dev.vars is gitignored; .dev.vars.example carries placeholders.
