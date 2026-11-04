# Design

## Source of truth
Status: Active. Date: 2026-11-04. Surface: Phogaem local library and explicit mlhops shared-library integration. Evidence: README.md, docs/architecture.md, docs/plan.md and the user's shared-library, filtering and TV-viewing requirements. No existing screens, brand assets or screenshot references exist.

## Brand
포갬 / Phogaem. Calm, personal, quietly playful. Layered photo mark and warm greens. Trust comes from honest local-storage and download-state labels. Avoid cloud-service jargon in the main flow, gradients, glossy dashboard cards and fabricated travel photographs.

## Product goals
Collect travel originals, remove exact duplicates, select only wanted photos, view together on a large screen. Success: import → filter → select → download without losing originals. No public launch, R2 calls, deletion, visual-similarity matching or native TV app in this iteration. Server authentication is explicit and uses mlhops.

## Personas and jobs
Four friends after a trip; a phone user importing originals; a desktop user collecting friends' photos; a group watching on a connected TV. Local mode simulates members in one browser; shared mode uses verified server identities and actual membership.

## Information architecture
One album screen at /phogaem/: brand and local status, album heading, member switcher, import action, combined filters, selection controls, photo grid, persistent download tray. Modal image viewer and download receipt review. Shared-library manager provides explicit device/passkey connection, album creation/selection, invitation and refresh. Local mode remains the default.

## Design principles
Images first. Separate viewing from selection. Preserve original bytes. Make filter combinations and empty results understandable. Show duplicates as one original with multiple contribution records. Record requested download separately from user-confirmed receipt.

## Visual language
Tokens in apps/web/src/styles.css. Warm off-white canvas, white surfaces, ink #263128, olive #485e35, pale sage accents. System sans-serif stack for Korean, large compact heading and small uppercase English eyebrow. 4/8px spacing scale, 12–20px panel radii, restrained borders, minimal shadows. Icons are local inline SVG. Demo landscapes are generated local illustrations labelled as samples. No remote fonts, images or analytics.

## Components
BrandMark, icon button, member selector, filter chip (multi-select), photo card (view and select independently), import/drop area, empty state, notice, download tray, receipt panel, full-screen viewer. Shared styling tokens live only in styles.css. Use native buttons, inputs and selects.

## Accessibility
Target WCAG 2.2 AA. Visible focus, labelled controls, text with badges, aria-pressed filter state, aria-live notices. Modal traps focus and restores it on close; Escape, left/right navigation, pauseable slideshow, reduced-motion support. Touch targets at least 44px. Images have file-name alternatives; failed decoding has an explicit fallback.

## Responsive behavior
390px mobile: stacked heading/actions, horizontally scrollable filters, two-column photo grid, safe-area-aware bottom tray. Tablet three columns; desktop four columns with max-width 1440px. Large viewer uses contain-fit originals on dark canvas. No hover-only essential actions.

## Interaction states
Shared APIs require core account approval. Pending users see their account code, existing-passkey sign-in, first-passkey registration and approval retry. Revocation clears shared photos, viewer and selection on the next denied request. Local-only library remains independent.

Initial empty album offers own-file upload and explicit sample loading. Busy imports show status and block concurrent mutations; existing photos remain visible. Offline local operation is supported while loaded. Storage quota and invalid files show actionable errors. No-match filters offer reset. Failed album switches preserve the prior album and photos; successful metadata loads switch the source together. Failed previews preserve download access. Downloads require a deliberate user action; receipts are confirmed or reset explicitly.

## Content voice
Friendly concise Korean. 보관함, 내 사진, 받은 사진, 원본, 중복. ‘다운로드 요청됨’ is not ‘저장 완료’. Always show that prototype data stays in this browser. Samples are labelled. Local mode describes device-only storage; shared mode describes server storage and actual invitations.

## Implementation constraints
React + TypeScript + Vite static build at /phogaem/. Native IndexedDB and Web Crypto; optional explicit mlhops connection, no R2 storage calls or storage credentials. Shared preview originals are lazy, paced and released off-screen. JPEG/PNG/WebP and original HEIC with fallback. Max 50MiB per local import and 16MiB per shared import. Verify domain logic with node:test; interactions and 390px/1920px layouts with Playwright on local Chrome. Keep screenshots in ignored test-results/.

## Open questions
- [ ] User: confirm long-term display names for real members; current shared members use ‘나’ and numbered ‘여행 친구’.
- [ ] Implementation: multi-file archive/streaming strategy and HEIC previews need separate validation; initial download queue handles one original per explicit action.
- [ ] User: retention period and direct-R2-transfer exception remain decisions for later integration.
