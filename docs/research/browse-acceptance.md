# Browse acceptance evidence

[Research index](README.md) · [Browse guide](../browse-and-compare.md)

Historical verification record migrated from the README. This records the stated scope and remaining checks for that delivery, not the result of a new live acceptance run.

B18 subtasks #1–#4 are implemented and packaged. Subtask #5 remains open for manual desktop and live Sitecore acceptance; see [BACKLOG.md](../../BACKLOG.md).

Verification for 0.25.2 (2026-10-03):

| Verification | Evidence / limit |
| --- | --- |
| Unit and VS Code 1.100.0 extension-host suites | Session cancellation, modes/preferences, missing partners/languages, explicit locks, action targeting, navigation, connection deletion/cache recovery, credential-wait supersession, activation and Compare regressions; mocked Sitecore transport. |
| Automated browser UI smoke | Real tree/details assets in headless Edge with a simulated VS Code bridge: full-width Browse, menus and all publish/task/link message targets, copying, filters, escaped text, empty/error states, keyboard navigation, narrow layout, conditional cancellation, mode/selection/expansion and 800px scroll restoration. |
| Delivery | Type check, VSIX packaging and file review, redacted package secret scan, installation in a temporary isolated VS Code profile. |
| Pending manual desktop checks | Native Extension Development Host focus, pickers, actual sidebar/details interaction, themes and rapid switching. Native desktop control is unavailable in this agent session; automated host/browser checks do not replace these. |
| Pending live Sitecore checks | Real search/site/favorite navigation, Standard/Traced/Power Publish, task execution, public-page resolution and the null-language publishing-status fix. No live credentials or remote content mutations were used for verification. |

For manual acceptance, open a connection, navigate/search and inspect an item, switch Compare/Browse with different languages, cancel a first-time partner picker, reload to verify remembered partner/language, and check that Browse keeps the left selection and view. In an approved test environment, verify each publish mode, a matching item task and the public-page link, then compare the result with the Operations record.
