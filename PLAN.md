# Agent Arena execution plan

## Agreed product

Two external assistants battle through one provider-independent MCP server. Players use their own assistant account and allowance. Our platform hosts the arena, validates moves, records results, and animates the battle; it never calls a model API. A deterministic engine is the judge.

## Completed in 0.2

1. **Authoritative referee.** Extracted the rules into a pure deterministic engine. The server owns movement, cover, damage, resources, danger, deadlines, and victory. All input is validated before a move is committed.
2. **Two locked seats.** Match creation produces two private random seat tokens. Tokens are hashed in SQLite. Stable agent IDs lock registrations, and neither seat can act on behalf of the other.
3. **One MCP connection surface.** Implemented six tools: rules, join, observation, wait, action, and result. Streamable HTTP supports legacy initialization and modern stateless discovery. A stdio bridge serves local desktop/CLI clients.
4. **Reliable matches.** SQLite transactions serialize actions. Request receipts prevent duplicate execution. Absolute deadlines survive disconnections/restarts. Missing turns wait; three consecutive misses forfeit.
5. **Live visual interface.** Replaced simulated-agent selectors with invitations and spectator controls. Kept cyan/orange identity and portraits. Added active-turn emphasis, coordinates, countdowns, a live decision feed, reconnecting spectator streams, and replay seek/play/step/download.
6. **Verification and handoff.** Backend and protocol tests cover complete HTTP MCP battles, concurrency, invalid moves, resource rules, restart recovery, deadlines, secret redaction, SSE reconnects, and both protocol eras. Added README, host configuration, and Docker packaging.

## Verification limits

- Complete-match tests use independent scripted MCP clients, not live provider sessions.
- Browser automation could not capture Chrome: `FrameArrived timed out: timed out waiting on channel`. Rendered desktop/mobile visual QA is therefore unverified.
- The earlier Sites project is unpublished and static. This Node/SQLite backend requires persistent Node hosting; public HTTPS hosting is not configured. The complete backend was not published as a misleading static-only site.
- Docker configuration is supplied but no Docker build/run was available or verified in this session.

## Next acceptance milestone

Deploy the complete backend to one persistent Node host behind HTTPS; connect two supported assistant sessions; send each its seat invitation; observe a complete match with no platform model calls. Record client-specific setup, confirmations, continuation behavior, and usage limits. Keep the game turn-based and allow reconnection.

## After the connection proof

- Spectator sessions: verify that people understand decisions, finish watching, and want rematches.
- Improve action trails, movement animation, optional sound, and visual impact based on observed matches.
- Add user accounts, invitation recovery/revocation, public registration with quotas, and match retention before a broad launch.
- Add cross-provider onboarding only after each actual client is tested. Keep a compatibility matrix.
- Treat model identities, token budgets, and single-process claims as unverified for externally controlled agents. A controlled tournament mode is a separate future feature.

## Visual principles

The board has priority. Use shape and labels as well as color for team identity. Show who is deciding, what action was accepted, and its outcome. Preserve responsive layout, keyboard controls, contrast, and reduced-motion support. Animation never changes the authoritative result.
