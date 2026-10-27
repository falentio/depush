1. Target Pusher Channels protocol v7 only. Reject protocol >7 or <7 with 4007 and a missing protocol with 4008. No v1-6, XHR, flash, or fallback transports.
2. Reuse the existing Workers scaffold: Vite + Hono + Valibot + Durable Objects + Vitest in workerd. No frontend, no accounts, no teams, no quotas, no billing. Delete the depush deployment domain, D1, and Drizzle.
3. One app from env PUSHER_APP_ID, PUSHER_APP_KEY, PUSHER_APP_SECRET. One AppHub Durable Object per app is the single writer for sockets and channel membership.
4. Drop-in means official pusher-js 8.x and the official pusher Node server SDK work unmodified, including HTTP signatures, body_md5, socket_id exclusion, and protocol frames. Protocol units run scripts/compat.mjs.
5. A unit is done only when pnpm check, pnpm typecheck, pnpm test, pnpm build, and the compat harness pass. Put the command output in the report.
6. One worker at a time on branch unit/<id>. Never rebase or force-push. The coordinator reviews and lands on local main. There is no remote and no PR.
7. TypeScript strict: no any, casts, ts-ignore, or non-null assertions. Valibot parses every inbound frame and HTTP body. No narration comments.
8. v1 excludes webhooks, cache channels, Live Activities, Beams, user signin/watchlists, and encrypted channels. Encrypted channels get a 4009 error; no key derivation, no shared-secret provisioning.
9. Stay inside the unit brief. Park anything else as a follow-up in the report; do not widen the diff.
10. Secrets never get committed. .dev.vars is gitignored; .dev.vars.example carries placeholders.
11. v0.2 lifts order 8's cache exclusion. Cache channels are in scope. Webhooks, encrypted channels, user signin/watchlists, terminate connections, and publish info remain out.
12. Per-channel durable state lives in a Channel Durable Object at idFromName(`${appId}:${channel}`). AppHub stays the single owner of live WebSockets and presence. Do not put cache/history rows in AppHub and do not add D1.
13. Cache channels are cache-, private-cache-, and presence-cache-. The last server-published event replays as a normal channel event after subscription_succeeded; a miss sends pusher:cache_miss. Client events are not cached. TTL is PUSHER_CACHE_TTL_SECONDS, default 1800 and at most 1800.
14. History and presence-info are signed depush extensions, not Pusher routes. Keep /channels/:name/users and every supported route unchanged. History retention is 24 hours and 1000 events per channel.
15. Every unit runs scripts/compat.mjs with the official pusher-js and pusher SDKs plus the full gate list. The harness count grows; all checks pass.
16. A unit is done only when the report has command output, the README matches the code, and wrangler types has no diff.
