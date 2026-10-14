# Dispatcher proposal JSON failures

Investigation date: October 13, 2026.

> **Follow-up:** suggestion 6 is now implemented. With OpenCode the Dispatcher writes its plan as an outline plus one call per Station, saved in D1 and assembled in code, so a slip costs one piece. See `docs/dispatcher-planning.md`.

## Summary

All three Dispatcher proposal submissions on Oct 13 were rejected as `invalid_json` because GLM-5.3 closed every Station's `scope` list with `}` instead of `]`. Neither repair step handles a wrong closing bracket. The rejection gave only a character position, so the model resubmitted the same mistakes until Terminus stopped it after 3 attempts.

A spike tested schema-constrained decoding on Workers AI as the alternative. It guarantees valid JSON, but with GLM-5.3 half the plans came back empty or wrong, so the text submission path stays. Rejections now quote the broken spot and say which bracket is open there.

## What the logs showed

The failing plan was `dispatch-5a631e86…`: Goal B from `docs/test-prompts/04-lines-then-junction.md` (a Customer profile Junction), planned by `@cf/zai-org/glm-5.3` between 22:00 and 22:05 UTC. Each submission was decoded from its AI Gateway response, and each fails at exactly the position the tool reported.

| Submission | Time (UTC) | Size (chars) | Parse error at | `scope` lists closed with `}` |
| --- | --- | --- | --- | --- |
| 1 | 22:01:42 | 21,782 | 5,835 | 8 of 8 |
| 2 | 22:03:07 | 21,741 | 5,835 | 8 of 8 |
| 3 | 22:05:20 | 21,769 | 5,807 | 8 of 8 |

`scope` comes right after the `repositoryChange` object, and the model repeats the `"},"` it has just written:

```
"repositoryChange":{"kind":"implementation","description":"…"},"scope":["…","…"},"expectedAreas":[…]
```

Some Stations also lose the `]` of their final `projectFacts` list entirely (`…"}},{"key":…`). Submission 1 also closed one `acceptanceCriteria` list with `}`.

**Why repair failed.** `repairBrackets` only handles missing closers. It reads the stray `}` as a skipped `]` and closes the `manifest` too, which scrambles the structure. `jsonrepair` 3.15.0 (the latest) makes the same assumption and throws at about character 11,500. Both fail on all three submissions.

**Why retries never converged.** The rejection said only "position 5835". The model could not count there, blamed an unquoted `depends_on` that was actually quoted, and copied its previous submission with every slip intact. Its last step spent about 14,000 characters of reasoning trying to count.

## Ruled out

The JSON was malformed as the model wrote it; nothing between the model and the parser changed it.

- **Worker proxy:** `sandbox-outbound.ts` passes model bytes through unchanged. Decoded submission 3 is 21,769 characters, exactly the length the proposal tool logged.
- **Truncation:** every call finished with `tool_calls`, well under the 16,384 output-token limit, and the error sits in the first third of the text.
- **Unescaped quotes:** this was the first theory. The decoded text has no stray quote at any error position.
- **Provider escaping:** the outer tool-call JSON decodes cleanly in all three responses.

One trap when pulling more of these: the AI Gateway dashboard's response export starts with a merged copy of the stream that drops fragments. The raw chunks after it are the accurate copy.

## Structured output spike

Workers AI does enforce a JSON schema for GLM-5.3 by constraining decoding, but only 5 of 10 constrained plans were usable. The other 5 were valid JSON with the plan lost or invented.

The spike (`scripts/json-mode-spike`) calls `glm-5.3` directly, without tools or streaming, with `response_format` set to the JSON schema generated from `dispatchProposalSubmissionSchema`. It tries both the OpenAI-compatible endpoint and `/ai/run`. There are two cases: copying the malformed live submission, and planning Goal B with the real Dispatcher prompt and the live run's findings. OpenCode's own structured output was not tested: it uses a `StructuredOutput` tool, so the model still writes the arguments freehand.

| Round | Schema sent | Runs | Valid JSON | Usable plans | What went wrong |
| --- | --- | --- | --- | --- | --- |
| 1 | Full schema | 4 | — | 0 | All rejected: `Failed to compile json grammar … Lookahead is not supported yet` (the area-path regex) |
| 2 | Regex patterns removed | 2 copy, 2 plan | 4 of 4 | 1 | Both copies cut at a quote the model left unescaped; 1 plan lost its Junction and filled `baselineFix` with placeholders |
| 3 | Plus properties reordered | 4 plan | 4 of 4 | 2 | 2 skipped `junctions` and filled `baselineFix` with placeholders |
| 4 | Plus `baselineFix` removed | 4 plan | 4 of 4 | 2 | 1 plan with no Junction that passed every check; 1 with invented `placeholder` Stations |

Usable plans still had ordinary planning issues (duplicate Station keys, a Crossing across the Junction boundary) of the kind the correction step fixes. Without `response_format`, the plan run returned clean JSON in 61 s; constrained runs took 15–151 s.

**How constrained decoding fails.** The decoder only stops syntax errors. A model mistake that is still legal syntax gets carried through, and the grammar forces whatever comes next:

- **Property order is fixed.** Once the model writes `lines` before `junctions`, `junctions` can no longer appear, so the plan goes into whatever slot is left.
- **A bare `"` ends the string.** The grammar then forces the shortest valid finish, `"lines":[]}`, and about 21,000 characters of plan are lost.
- **A dropped `]` becomes a new item.** `},` after a Station means another Station follows, so the model invented one: key `p-header-route`, every field `placeholder`.

Parse errors became content errors. One plan passed Zod and `assessPlan` while its summary described a Junction the plan did not contain; only the launch review would have caught it.

## Change made

Rejected proposals now show the model where parsing stopped, so it can fix the exact spot instead of guessing from a character position.

- `jsonParseHint` in `packages/agent-runtime/src/opencode.ts` quotes about 160 characters before and 80 after the failure point, with a `<<<HERE>>>` marker. It then names the innermost open value there, and says so when a `}` tries to close an array or a `]` an object.
- Positions come from the same JSON slice `finalMessageJson` parses (a new `answerJson` helper), so the quote always matches the parser.
- It reports what the parser saw and repairs nothing. Bracket repair and `jsonrepair` are unchanged.
- The Dispatcher's tool replies and correction messages use it, and so do the Conductor's verdict corrections. The opening now reads "The JSON is not valid" instead of "Your final message", which was wrong for tool submissions.

What the live Dispatcher would now have received for submission 1:

```
The JSON is not valid. The parser reported: Expected ',' or ']' after array element in JSON at position 5835 (line 1 column 5836)
The text around that point, with <<<HERE>>> where parsing stopped:
… consistent with the existing panels."<<<HERE>>>},"expectedAreas":["src/features/support/customer-profile/header.tsx", …
There, the `scope` array is still open, and `}` cannot close it: it closes with `]`.
The parser stops at the first problem, so check the rest of the JSON for the same mistake before sending it again. …
```

Tested offline: 4 new unit tests for the hint and 1 Dispatcher test that rebuilds the live failure. All 138 agent-runtime tests, both typechecks and lint pass. It has not run in a live Dispatcher session yet.

## Suggestions

In priority order:

1. **Run Goal B live again.** The new rejection is only verified offline. The question is whether GLM fixes all 8 `scope` lists after one precise rejection.
2. **Keep the text submission path** and the Zod and `assessPlan` gates. Don't use schema-constrained decoding for whole proposals: in 5 of 10 runs it turned slips into empty or invented plans.
3. **For the demo, keep the model switch in reserve.** If GLM still can't converge, the Dispatcher model is a setting, and Kimi K2.7, Claude and GPT are in the catalog. `AGENTS.md` limits live testing to GLM, but switching is approved for the demo.
4. **Log the rejections.** The `dispatcher.proposal_tool` perf record logs only `accepted`. Adding the parser message and the quoted excerpt would make the next failure readable from the tail log, without gateway exports.
5. **Review the repair steps.** On some inputs `repairBrackets` and `jsonrepair` return valid JSON with the wrong shape; `jsonrepair` can split one string at an unescaped quote into two list items. Schema validation catches most of these, not all.
6. **Later, submit in smaller pieces:** Junction metadata, Lines and Stations, assembled in code, so a slip costs one piece. That needs storage between tool calls and the cross-piece checks at assembly. Constrained decoding may be worth retrying per piece, where objects are small and the order is simple.

## Evidence

Paths are relative to the `terminus` repo. `docs/temp` is gitignored, so logs and spike results are local only; the spike script and the code change are uncommitted.

| Item | Where |
| --- | --- |
| Perf tail log | `docs/temp/perf-logs/tail-perf-logs-oct-13-417pm.json` |
| AI Gateway log IDs | `01a13748-2fda-7074-bafe-56380107f4cf`, `01a13749-3f0e-74ea-9fc7-75784a9a0a75`, `01a1374a-7e70-76bc-970e-b6c89cf27da7` |
| Gateway response exports | `docs/temp/perf-logs/01a13748-…-response.json`, `01a13749-…-response.json`, `01a1374a-…_response` |
| Spike script | `scripts/json-mode-spike/` (`spike.ts`, `run.mjs`) |
| Spike fixtures | `scripts/json-mode-spike/fixtures/submission-1.txt` (the malformed live submission), `findings.json` |
| Spike results, round 1 and controls | `docs/temp/json-mode-spike/2026-10-14T01-07-24-105Z/` |
| Spike results, rounds 2–4 | `docs/temp/json-mode-spike/2026-10-14T01-08-52-294Z/`, `…01-22-32-288Z/`, `…01-31-46-235Z/` |
| Code change | `packages/agent-runtime/src/opencode.ts`, `dispatcher-agent.ts`, `conductor-agent.ts`, with tests in `opencode.test.ts` and `dispatcher-agent.test.ts` |

To rerun the spike: `node scripts/json-mode-spike/run.mjs` reads credentials from `apps/worker/.dev.vars`, and `--dry-run` sends nothing.


## October 14, 07:12 MDT follow-up: Station calls never reached Terminus

The tail export `docs/temp/perf-logs/tail-perf-logs-oct-14-712am.json` records plan `dispatch-207dcc86ca90452cb96413dbb8b20288` running on configured `@cf/zai-org/glm-5.3`. The outline saved successfully, naming nine Stations. All 20 subsequent tool calls were reported as `invalid` by OpenCode; no `put_station` call reached the plan server. Most parse errors show bare prose after `"scope":` even though the tool declared an array. The excerpts do not establish whether the model or the provider's tool serialization lost the syntax; raw Gateway response inspection would be needed to distinguish them.

The runner stopped at the existing 20-rejection limit (`proposal_rejected`). The saved draft therefore contained its outline and no Stations, and assembly correctly reported `stations (missing_station)`. There was one session run and zero resumes, not three proposal attempts. Total session time was about 274 seconds; increasing retries would only prolong the observed loop.

The Station tool now advertises both arrays and text for every model: string lists accept one item per line or JSON array text, and contracts accept an array of objects or JSON array text. This matches the normalization the server already supports, without a model-specific Station format. The Dispatcher prompt includes the same tool input schema, a complete flat Station argument example, and an equivalent text-list example. The full Station schema, draft assessment and final Workflow validation still apply. The terminal error now distinguishes the tool rejection limit from three exhausted session attempts. Offline tests cover both advertised formats, the prompt examples, typed Manifest persistence, Line-shared values and rejection of invalid paths and unknown evidence. This change still needs a fresh live Dispatcher run; the failed plan cannot be completed from the saved outline alone.
