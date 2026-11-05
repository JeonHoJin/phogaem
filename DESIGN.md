# Design

## Source of truth
Status: Active. Date: 2026-11-05. Surface: Phogaem shared travel library, photo collection/download and large-screen viewing.

This file defines the experience implemented in the current working version; publishing follows the verified Pages workflow. Evidence reviewed: README.md, docs/plan.md, docs/approval.md, apps/web/src/App.tsx, existing styles and browser scenarios; the user's explicit requirement is zero explanatory or guidance copy, including exceptional states. Existing implementation includes local-first entry, explanatory paragraphs, notices and a shared-library manager; these are migration inputs, not target decisions. Existing synthetic screenshot baselines are implementation references, not an approved target mockup.

The user journey is specified in [docs/user-flow.md](docs/user-flow.md). This file owns design rules; technical/security contracts remain in docs/architecture.md and docs/approval.md.

## Brand
포갬 / Phogaem. Calm, personal, quietly playful. Preserve the layered photo mark and warm greens. Photos and direct interaction carry the experience. No visible slogans, promotional eyebrows, feature introductions, reassuring paragraphs or technical explanations. Avoid gradients, glossy dashboard cards and fabricated travel photographs.

## Product goals
Collect travel originals, merge byte-identical duplicates, select wanted photos and download them; enjoy photos together on a large screen. Success means participants can complete these jobs without reading instructions.

Private R2 storage and supervised thumbnail/Gemma processing are implemented. Manual comparison candidates use the existing analysis descriptors; they are not a production verdict that images are identical. No automatic merge/delete, best-shot verdict, deletion/retention UI or native TV app is introduced. Shared-account approval and album membership remain mandatory.

## Personas and jobs
About four travel friends: a phone user contributing photos, a returning participant collecting friends' originals, and a group viewing on a connected TV. Participants navigate real shared libraries under their own accounts. Simulated member switching and browser-only samples are development/secondary surfaces, not the normal entry experience.

## Information architecture

Invitation links use a dedicated join surface, never the create-library form. An existing approved account joins and opens the invited album directly; a new browser still requires explicit sign-in/start and account approval, then continues to the same album automatically. Pending access retains the link. Expired/replaced/full/unavailable invitations offer icon-based states and retry or replacement-link input. Opening an invitation in an already-running app is handled; closing it cancels automatic participation. Successful entry resets previous photo filters.
- `/phogaem/` enters sign-in or the participant's library list. Existing identity may resume its session; first visit alone must not create an identity or open a passkey prompt.
- An invitation opens its travel context and preserves that destination through sign-in and approval. Album access begins only after approval, membership checks and explicit participation.
- Library list: trip cover/name, participant avatars, photo count and create action. New album names default to the browser-local date as `yymmdd 여행`; preserve edited drafts. New users see the create action without an introductory paragraph.
- Album: trip name, participants, upload, filters and photo grid. Selection reveals a compact download tray. Viewing and selection are distinct interactions.
- Comparison: an explicit `비교` action loads candidate groups for the current shared album. Groups intersect the active photo filters and need at least two visible members. A comparison modal presents at most four thumbnails at a time; originals load only on explicit expansion, with paging, shared selection, larger viewing and the existing download flow. No confidence percentages or explanatory copy.
- Viewer: contain-fit photo, previous/next, slideshow, fullscreen and close. Controls can recede during viewing and remain keyboard/touch accessible.
- Invitation/account actions are secondary controls. No shared-connection management step, storage-mode chooser or technical account explanation in the main journey.
- Local library and synthetic samples remain explicitly separate secondary/development entry points; never present local uploads as shared. Moving existing local photos to a shared album requires a deliberate action.

## Design principles
1. Zero visible explanatory/guidance copy, with no exception for errors, approval, offline states, unsupported previews or empty screens. If the flow requires an explanation, change the interaction.
2. Allow essential identity/action data: trip and participant names, filenames, concise button/filter/field names, dates, counts, bytes and numeric progress. Do not disguise explanations as headings, button labels, tooltips, placeholders or short status badges.
3. Express state through placement, stable visual state, progress, icon/shape and available actions. Never depend on color or animation alone. Visible labels name actions or entities, not sentences about what is happening.
4. Images first. Clicking a photo opens it; a separate selection control/mode selects it. Multi-select exposes the next action beside its count.
5. Preserve originals. Merge byte-identical originals while retaining contributors. Similar photos must not be silently merged or deleted.
6. A download request is not a confirmed receipt. Keep distinct visual states and a deliberate receipt toggle/reset; never infer file-system completion from a browser download event.
7. Recovery must be actionable at the affected item or region. Do not replace guidance paragraphs with unexplained dead ends, disabled controls or endless spinners.

## Visual language
Reuse tokens in apps/web/src/styles.css: warm off-white canvas, white surfaces, ink #263128, olive #485e35 and pale sage accents; system Korean sans-serif, 4/8px spacing, 12–20px radii, restrained borders and minimal shadows. Remove decorative English eyebrows and marketing headings from product screens.

Use consistent local SVG icons for upload, download, selection, receipt, retry, lock, connectivity, copy, fullscreen and playback. Each state must have a shape/icon and stable layout representation; motion supplements it. Numeric upload progress may use `12/48` and a progress track. Photos and explicit synthetic sample thumbnails supply imagery. No remote fonts, images or analytics.

## Components
Reuse BrandMark, native controls, filter chips, photo cards, photo grid, selection tray and fullscreen viewer. Evolve the shared manager into library-list, sign-in, invitation and account surfaces. Add item-level upload progress/retry states, a lock/pending access surface and a receipt toggle with distinct requested/confirmed appearances.

Add candidate group cards and a comparison modal using existing Preview, Modal and selection controls. Candidate loading/error/empty states use icons, numeric counts and explicit refresh/retry. Stale requests cannot restore data after source/album changes or approval denial.

Remove sentence-based empty-state headings, helper paragraphs, banners, success/error toasts, hover tooltips, dialog footnotes and preview explanations. Dialogs remain only where an actual choice/input is needed. Field labels and concise action names may remain; placeholder instructions do not. Shared tokens stay in styles.css; no parallel design system.

## Accessibility
Target WCAG 2.2 AA. Keep nonvisual accessible names, state descriptions, error associations and live announcements for assistive technology; the zero-copy requirement concerns visible guidance. Do not remove semantics to hide text.

Use native controls, visible focus, aria-pressed/selected states and meaningful image alternatives. Icon-only controls have accessible names but no explanatory browser `title` tooltip. Modals restore focus; Escape closes; arrows navigate photos; slideshow is pauseable and respects reduced motion. Touch targets are at least 44px. State is distinguishable without color, motion or hover. Treat any unresolved nonvisual recovery state as a design defect, not permission to add visible guidance.

## Responsive behavior
390px mobile prioritizes photo picking/upload, a two-column grid, compact filter controls and a safe-area-aware selection tray. Tablet uses three columns; desktop uses four with a 1440px content maximum. Desktop supports drag/drop and keyboard selection/viewing. TV via a connected browser emphasizes a dark contain-fit viewer and minimal playback controls. No essential action depends on hover. Longer filenames/trip names must not cause overflow.

## Interaction states
All rows obey zero visible guidance copy. Concise control names and concrete values are allowed.

| Situation | Visible response and recovery |
| --- | --- |
| Loading | Region skeleton/progress; retain stable layout and already-loaded photos. |
| Empty library list / album | Create / upload control in the content region; no empty-state sentence. |
| No filter matches | Keep active filters visible with a reset action in the empty grid. |
| Upload in progress | Per-file thumbnail/progress and aggregate numeric count; prevent conflicting actions. |
| Upload rejected / interrupted | Mark the affected item with a distinct failure icon and retry/remove/reselect actions; retain successful items and pending selection. File selection constrains supported formats. |
| File/storage capacity limit | Preserve queued items, identify affected items, expose remove/reselect and capacity values where known. Do not offer an unchanged retry for a deterministic rejection. |
| Slow/offline | Static connectivity state plus retry on affected region; preserve entered data. Do not silently start new uploads on reconnection. |
| Approval pending | Lock/pending appearance, account code, recheck and account-switch actions. Keep invited trip context; no explanation or automatic admission. |
| Approval revoked | Clear protected photo/viewer/selection state on denial; return to the locked surface. |
| Invalid/expired invitation | Unavailable invitation state with exit and replace-link controls; do not join automatically or bypass approval. |
| Failed album transition | Keep prior album and photos together; retry at the target selection. |
| Preview unavailable | Photo/file placeholder with download action; retry only for a retriable fetch failure. |
| Download | Original download action, separate requested/receipt icons and explicit receipt toggle/reset. Cancellation or failure never sets confirmed receipt. |
| Operation completed | Updated grid, progress or icon state is the feedback; no toast or success sentence. |

Authentication may invoke browser/OS-owned passkey or file/download dialogs. Their text is outside the app's rendering control. Do not add application-owned explanatory copy around them; do not claim platform dialogs contain no text.

## Content voice
Visible product language consists of identifiers, compact action/filter/field names and concrete values. Examples: `올리기`, `선택`, `다운로드`, `재시도`, `참여`, `내 사진 제외`, `받은 사진 제외`, `12/48`, `64 MB`. This is not an exception allowing short explanatory statuses such as “승인을 기다려 주세요”.

No onboarding prose, help copy, slogans, status sentences, toast messages, error reasons or technical details appear in the product UI, even when an operation cannot continue. Help/tooltips must not become a hidden alternative guidance flow. Technical documentation and nonvisual accessibility descriptions can explain behavior. Name the actual state honestly: no UI may represent a requested download as saved, or a local-only photo as shared.

## Implementation constraints
React + TypeScript + Vite at `/phogaem/`; native IndexedDB/Web Crypto and approved mlhops operations. No new dependencies or actual R2 requests are required by this design. Keep CSP, transport/session protections and approval/membership checks. Never weaken authentication to shorten a journey.

Shared originals are lazy, paced and released offscreen. Shared limit remains 16MiB/photo; secondary local mode 50MiB. Preserve HEIC originals even when preview fails. Selected originals download with one action: a single original stays a direct file, multiple originals use a dependency-free stored ZIP32 with UTF-8 safe filenames and CRC32. Archives are capped at 256MiB of originals; the download dialog shows size/capacity and lets users remove entries. Receipt confirmation remains separate.

Acceptance for the UI migration: traverse normal, empty, loading, failed, offline, pending/revoked approval, expired invitation, unsupported preview and partial-upload/download flows without app-owned guidance copy; verify useful recovery and no false success. Check semantic accessibility and 390px/1920px layouts. Existing tests asserting explanatory text must migrate to state/action/result assertions while retaining security and byte-preservation coverage. No automatic approval, production test identities or real user-photo fixtures.

## Open questions
- [ ] Product/implementation: choose participant display-name capture/management; names must identify actual contributors without instructional onboarding.
- [ ] Implementation: validate batch delivery on physical mobile browsers; ZIP byte preservation and separate receipt states are covered by automated browser tests.
- [ ] Implementation: validate whether icon/shape/action vocabulary makes pending access, deterministic rejection and unavailable previews understandable on mobile; improve the structure if testing exposes ambiguity.
- [ ] Product: retention duration and future R2 authorization remain separate decisions, with no cloud cost introduced by this contract.

The shared `중복` filter includes repeated identical-file imports and known members of similar-photo candidate groups. It fetches candidates without opening comparison, refreshes on analysis state changes, and retains AND semantics for the other active filters. Similarity never changes original bytes, exact deduplication, or receipt state.
