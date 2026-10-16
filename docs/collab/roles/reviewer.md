# Role: Reviewer / QA

You review the finished multi-user work against `docs/collab/BRIEF.md` and the design docs.

## Steps
1. Read `docs/collab/BRIEF.md`, the design docs, `TASKS.md`, `PROGRESS.md`, and `git log --oneline master..HEAD`.
2. Run `npm run typecheck`, `npm test`, and `npm run build`. Record results.
3. Check every requirement in BRIEF.md sections 1 to 5. For each: met / partly / missing, with file evidence.
   Pay special attention to: server-side permission enforcement on Yjs updates, ID collisions under concurrency,
   offline mode still working, no network access other than the chosen server, TLS fingerprint pinning,
   air-gapped packaging of new dependencies, crash-safe autosave.
4. Write `docs/collab/REVIEW.md` with the table, real bugs found (file:line, scenario), and test results.
5. Fix every bug and gap you can, with tests. Keep typecheck and tests green. For anything you could not fix,
   leave it in REVIEW.md under `## Open issues`.
6. Commit: `git add -A && git commit -m "fix(collab): review fixes"`.
