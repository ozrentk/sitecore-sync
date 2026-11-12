# B27 acceptance review — 2026-10-26

## Decision

**Closed on 2026-11-12 to the scope accepted by the user.** The selected language applies to the whole tree. Preview may use fallback without identifying the source language; the tree must display that limitation. Exact Authoring Details and Edit remain separate. Live populated File and nested/base partial-design checks are deferred, not passed.

## Evidence by layer

| Check | Result and scope |
| --- | --- |
| Live UI: existing Dev vehicle page | Development Host, not an installed production-profile VSIX. 39 component occurrences loaded in en and en-NZ; desktop split layout and narrow tree layout observed. |
| Live lazy references | Main Navigation expansion loaded field groups, an internal Home link and primary navigation list targets. No automatic asset downloads or content writes were invoked. |
| Actual-target Details | Selecting Home showed the Home path/identity and exact en version 12, independently of the owning vehicle page. |
| Fallback distinction | en-NZ Preview still displayed 39 components; Main Navigation Details showed requested en-NZ, exact Authoring en-NZ version 0, no exact fields and disabled Edit. Source locale remained unknown in the tree header. |
| Locale change and Refresh | Locale change cleared prior Details and reloaded en-NZ. Refresh cleared Details and showed loading, then restored 39 components. This is live successful refresh behavior, not a deterministic race/cancellation proof. |
| Live API: paired vehicle-page layouts | Fixed diagnostic collected en and en-NZ with matching selected page/site/locale, 39 occurrences and maximum nested placeholder depth 3, one HTTP attempt each. No repeated immediate datasource IDs in this sample. |
| Live API: second existing page | Test Drive Week en-AU layout collected successfully with the expected page identity. Not a second integrated live UI test. |
| Repeated items, cycles, cancellation and stale responses | Synthetic graph and extension-host tests; existing suites cover independent occurrences, bounded reads/depth, locale/selection/close supersession and rejected stale actions. No claim of a new live repeated-item or timed-race reproduction. |
| Image/Content Hub | Read-only live evidence from 2026-10-23 remains applicable; see reference-provider report. Exact media IDs and paths were checked, not asset bytes. |
| File discovery | Additional bounded Fitting Instructions search and reads of one existing instruction item and its explicit child reference found an external General Link to a document, not a populated File field. Earlier three download candidates were also General Links. File remains schema/synthetic verified only. No broad crawl or sample creation. |
| Nested/base partial design | Bounded Partial-name discovery found the existing demo-site Partial Designs folder, confirmed empty. Ordinary placeholder nesting is present, but is not evidence of base partial-design inheritance. Earlier isolated standard partial fixture evidence remains historical and distinct; it was removed after testing. No new representative base/nested sample verified. |
| Installed artifact | 2026-11-12: v0.63.1 installed in regular VS Code. The installed extension bundle and Components script matched the VSIX. On Dev, en, the user confirmed that revealing Station Wagon → Main Navigation → logoLink → Home selected the Home row in Browse (expected path: `/sitecore/content/IAL/Grenadier/global/home`). This verifies the selection after navigation. |

Final automated checks: 533 unit tests and 125 extension-host tests passed, including the Reveal regression. Earlier Components and Rich Text waits timed out intermittently; no assertions were removed.

## Concrete defect found

Reveal referenced item in Browse activated the Browse tab but left the old vehicle page selected. `beginFavoriteNavigation` calls `cancelModeSwitch`, which advances `modeIntent`; `openDatasourceDetails` then compared the superseded intent and returned before tree loading/reveal. Capture the new navigation intent immediately after beginning navigation, retaining guards against later user actions. The regression now exercises the real mode-cancellation method instead of stubbing it away. No editor/save policy changes.

## Locale requirement and clarity

The tree has one Language control and a visible warning that Preview may use fallback without identifying its source language; lazy branches repeat source-unknown context. Exact Details separately reports requested and Authoring locale/version. This is truthful and avoids inventing per-node fallback provenance. No redundant per-node language badges were added during acceptance. Original per-node effective-locale/fallback-chain acceptance remains unmet; the user accepted tree-level requested-language context instead.

## Deferred checks and evidence limits

- The installed Reveal scenario passed; other live UI observations above were made in the Development Host.
- Deferred: check a populated File field and nested/base partial-design inheritance when representative live examples become available.
- Live repeated references and precise refresh/close races were not manufactured; their current evidence is synthetic.

No Sitecore content was created, modified, deleted or published. No assets were crawled or downloaded. No remote branches, releases or tags were published.
